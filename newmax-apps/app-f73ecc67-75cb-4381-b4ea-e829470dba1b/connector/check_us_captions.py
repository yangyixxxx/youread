"""用户显式授权的有限美国节点逐个检查；只使用映读专用组，不重试付费请求。"""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import quote
from urllib.error import HTTPError
import yaml

if __package__:
    from .caption_pool import ClashController, GROUP, PoolError, save_json
    from . import yt_worker as yt, server
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from caption_pool import ClashController, GROUP, PoolError, save_json
    import yt_worker as yt
    import server

US_GROUP = '🇺🇸 美国手动'
RESERVED = {'DIRECT', 'REJECT', 'GLOBAL', 'COMPATIBLE', 'PASS'}


def candidates_from(proxies):
    values = proxies.get(US_GROUP, {}).get('all')
    if not isinstance(values, list):
        raise PoolError('US_GROUP_MISSING', '当前Clash没有美国手动组，未猜测其它分组。')
    nodes, excluded = [], []
    for name in dict.fromkeys(values):
        value = proxies.get(name, {})
        if not isinstance(name, str) or name in RESERVED or 'all' in value or not value.get('type'):
            excluded.append({'name': name, 'reason': '不是可独立选择的真实代理节点'})
        else:
            nodes.append(name)
    if not 1 <= len(nodes) <= 64:
        raise PoolError('US_GROUP_INVALID', '美国真实节点数量不在1至64范围，本次未开始。')
    return nodes, excluded


def selections(proxies):
    return {n: p['now'] for n, p in proxies.items() if n != GROUP and p.get('type') == 'Selector' and 'now' in p}


def expand_config(original, nodes):
    result = copy.deepcopy(original)
    leaf_names = {p.get('name') for p in result.get('proxies', [])}
    if not set(nodes).issubset(leaf_names):
        raise PoolError('CONFIG_CHANGED', '实际节点与当前Clash配置不一致，未载入旧配置。')
    own = {'name': GROUP, 'type': 'select', 'proxies': list(nodes)}
    groups = result.get('proxy-groups', [])
    result['proxy-groups'] = [own if g.get('name') == GROUP else g for g in groups]
    if not any(g.get('name') == GROUP for g in groups):
        result['proxy-groups'].append(own)
    listeners = result.setdefault('listeners', [])
    own_listener = next((l for l in listeners if l.get('name') == 'yingdu-captions'), None)
    expected = {'name': 'yingdu-captions', 'type': 'http', 'listen': '127.0.0.1', 'port': 18883, 'proxy': GROUP, 'users': []}
    if own_listener:
        if any(own_listener.get(k) != v for k, v in expected.items()):
            raise PoolError('LISTENER_CONFLICT', '现有映读入口与预期不同，未覆盖。')
    else:
        if any(l.get('port') == 18883 for l in listeners):
            raise PoolError('PORT_CONFLICT', '专用端口已被其它入口使用，未覆盖。')
        listeners.append(expected)
    return result


class DiagnosticLogger(yt.QuietLogger):
    def __init__(self):
        self.flags = set()
    def debug(self, message, *args, **kwargs):
        lower = str(message).lower()
        if 'not a bot' in lower or 'confirm you' in lower and 'bot' in lower:
            self.flags.add('bot_verification')
        if 'po token' in lower or 'po_token' in lower:
            self.flags.add('po_token_required')
        if 'javascript' in lower or 'challenge solver' in lower or 'nsig' in lower:
            self.flags.add('javascript_challenge')
        if re.search(r'(?:http error|status code)\s*:?\s*429\b', lower):
            self.flags.add('http_429')
        if 'unable to download' in lower:
            self.flags.add('metadata_download_failed')
    info = warning = error = debug


def probe(video_id, output):
    logger = DiagnosticLogger()
    result = {'ok': False, 'stage': 'video_details'}
    started = time.monotonic()
    try:
        from yt_dlp import YoutubeDL
        options = yt.options('captions', 'http://127.0.0.1:18883')
        options['logger'] = logger
        with YoutubeDL(options) as downloader:
            info = downloader.extract_info('https://www.youtube.com/watch?v=' + video_id, download=False)
            if not isinstance(info, dict) or info.get('id') != video_id:
                raise yt.SafeFailure('INVALID_RESPONSE')
            result.update(formats=len(info.get('formats') or []), durationPresent=info.get('duration') is not None,
                          manualLanguages=len(info.get('subtitles') or {}), automaticLanguages=len(info.get('automatic_captions') or {}))
            if not info.get('formats') and info.get('duration') is None and not info.get('subtitles') and not info.get('automatic_captions'):
                raise yt.SafeFailure('CAPTION_LIST_UNAVAILABLE')
            result['stage'] = 'select_caption_track'
            language, source, track = yt.choose_track(info)
            result.update(language=language, source=source, format=track['ext'])
            result['stage'] = 'caption_download'
            data = yt.fetch_captions(info, 'http://127.0.0.1:18883')
            segments = server.parse_captions(data['raw'], data['format'])
            result.update(ok=True, stage='complete', segments=len(segments), captionBytes=len(data['raw'].encode('utf-8')), data=data)
    except HTTPError as error:
        result.update(code='RATE_LIMITED' if error.code == 429 else 'NETWORK_ERROR', httpStatus=error.code,
                      retryAfter=yt.retry_after_seconds(error.headers) if error.code == 429 else 0)
    except yt.SafeFailure as error:
        result['code'] = str(error)
    except Exception as error:
        result['code'] = 'RATE_LIMITED' if 'http_429' in logger.flags else 'AUTH_REQUIRED' if 'bot_verification' in logger.flags else 'NETWORK_ERROR'
        result['errorType'] = type(error).__name__
    result.update(diagnosticFlags=sorted(logger.flags), elapsedSeconds=round(time.monotonic() - started, 2))
    save_json(output, result)


def commit_caption(data_dir, video_id, data):
    directory = data_dir / 'connector'
    library_path = directory / 'library.json'
    library = json.loads(library_path.read_text(encoding='utf-8'))
    video = next(v for v in library['videos'] if v['id'] == video_id)
    # 现有字幕优先，绝不以测试结果覆盖已有正文。
    if video.get('transcriptStatus') == 'ready':
        return {'saved': False, 'reason': 'existing_transcript_preserved'}
    transcript = {'segments': server.parse_captions(data['raw'], data['format']), 'raw': data['raw'],
                  'format': data['format'], 'language': data['language'], 'source': data['source']}
    server.atomic_json(directory / 'transcripts' / (video_id + '.json'), transcript)
    video.update(transcriptStatus='ready', transcriptError=None, transcriptErrorCode=None)
    if data.get('publishedAt'):
        video.update(publishedAt=data['publishedAt'], datePrecision=data.get('datePrecision') or 'day')
    server.atomic_json(library_path, library)
    return {'saved': True, 'segments': len(transcript['segments']), 'language': transcript['language']}


def run_worker(video_id):
    with tempfile.TemporaryDirectory(prefix='yingdu-us-caption-') as tmp:
        output = Path(tmp) / 'result.json'
        command = [sys.executable, '-I', '-X', 'utf8', str(Path(__file__).resolve()), '--worker', str(output), '--video-id', video_id]
        started = time.monotonic()
        try:
            completed = subprocess.run(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       timeout=90, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            if completed.returncode or not output.exists() or output.stat().st_size > 16 * 1024 * 1024:
                return {'ok': False, 'code': 'WORKER_FAILED', 'stage': 'worker', 'elapsedSeconds': round(time.monotonic() - started, 2)}
            return json.loads(output.read_text(encoding='utf-8'))
        except subprocess.TimeoutExpired:
            return {'ok': False, 'code': 'NETWORK_TIMEOUT', 'stage': 'worker_deadline', 'elapsedSeconds': 90}


def sweep(config_path, data_dir, report_path, run_id):
    if report_path.exists():
        previous = json.loads(report_path.read_text(encoding='utf-8'))
        if previous.get('runId') == run_id:
            print(json.dumps({'cached': True, 'finished': previous.get('finished'), 'completed': len(previous.get('rows', []))}), flush=True)
            return 0 if previous.get('finished') else 3
        raise PoolError('REPORT_CONFLICT', '报告路径已有其它任务，未覆盖或重放。')
    controller = ClashController(config_path)
    initial = controller.request('GET', '/proxies')['proxies']
    nodes, excluded = candidates_from(initial)
    baseline = selections(initial)
    state_path = data_dir / 'connector' / 'caption-pool-state.json'
    state = json.loads(state_path.read_text(encoding='utf-8')) if state_path.exists() else {'cooldowns': {}, 'lastRequest': 0}
    library = json.loads((data_dir / 'connector' / 'library.json').read_text(encoding='utf-8'))
    video_id = 'sGpCq_VsDkc'
    if not any(v['id'] == video_id for v in library['videos']):
        raise PoolError('VIDEO_MISSING', '目标视频不在当前库，未查询其它视频。')
    report = {'runId': run_id, 'videoId': video_id, 'status': 'preparing', 'finished': False, 'total': len(nodes), 'excluded': excluded,
              'rows': [], 'candidateNodes': nodes, 'startedAt': time.time(), 'intervalSeconds': 20, 'perNodeTimeoutSeconds': 90,
              'sharedSelectionsPreserved': None, 'paidCalls': 0, 'savedCaption': None}
    save_json(report_path, report)
    launcher = Path(__file__).resolve().parent.parent / 'manage-connector.ps1'
    stopped = False
    best = None
    try:
        subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(launcher), '-DataDir', str(data_dir), '-Action', 'Stop'], check=True)
        stopped = True
        with server.InstanceLock(data_dir / 'connector' / 'instance.lock'):
            current = yaml.safe_load(config_path.read_text(encoding='utf-8'))
            config = expand_config(current, nodes)
            # 只重载一次。回执不确定时只读核验，绝不重放载入操作。
            try:
                controller.request('PUT', '/configs?force=false', {'payload': yaml.safe_dump(config, allow_unicode=True)})
            except PoolError:
                pass
            for _ in range(10):
                try:
                    if controller.members() == nodes:
                        break
                except PoolError:
                    pass
                time.sleep(0.5)
            if controller.members() != nodes:
                raise PoolError('PRIVATE_GROUP_NOT_APPLIED', '美国节点尚未进入专用组，停止测试。')
            after_load = controller.request('GET', '/proxies')['proxies']
            for name, value in baseline.items():
                if after_load.get(name, {}).get('now') != value:
                    controller.request('PUT', '/proxies/' + quote(name, safe=''), {'name': value})
            if selections(controller.request('GET', '/proxies')['proxies']) != baseline:
                raise PoolError('SHARED_SELECTION_CHANGED', '原代理选择未保持，停止测试。')
            report['status'] = 'running'
            save_json(report_path, report)
            print(json.dumps({'event': 'started', 'total': len(nodes), 'excluded': excluded}, ensure_ascii=False), flush=True)
            for index, node in enumerate(nodes, 1):
                if report_path.with_suffix('.stop').exists():
                    report['status'] = 'stopped'
                    break
                wait = max(state.get('lastRequest', 0) + 20, state.get('cooldowns', {}).get(node, 0)) - time.time()
                if wait > 180:
                    report['rows'].append({'node': node, 'ok': False, 'code': 'COOLDOWN_NOT_OVERRIDDEN', 'attempted': False, 'availableAt': state['cooldowns'][node]})
                    save_json(report_path, report)
                    continue
                if wait > 0:
                    time.sleep(wait)
                if selections(controller.request('GET', '/proxies')['proxies']) != baseline:
                    raise PoolError('SHARED_SELECTION_CHANGED', '其它代理选择发生变化，停止测试，不覆盖用户的新选择。')
                controller.select(node)
                state.update(lastRequest=time.time(), lastNode=node)
                save_json(state_path, state)
                result = run_worker(video_id)
                data = result.pop('data', None)
                row = {'index': index, 'node': node, 'attempted': True, **result}
                report['rows'].append(row)
                if result.get('ok'):
                    if report['savedCaption'] is None and data:
                        report['savedCaption'] = commit_caption(data_dir, video_id, data)
                    if best is None or row['elapsedSeconds'] < best['elapsedSeconds']:
                        best = row
                    state['cooldowns'].pop(node, None)
                elif result.get('code') != 'NO_CAPTIONS':
                    delay = 1800 if result.get('code') == 'RATE_LIMITED' else 300
                    delay = max(delay, min(86400, result.get('retryAfter', 0) or 0))
                    state['cooldowns'][node] = time.time() + delay
                state['lastError'] = None if best else '美国节点检查尚未获取到字幕，详情保留在本轮报告中。'
                save_json(state_path, state)
                report.update(successCount=sum(r.get('ok', False) for r in report['rows']), completed=len(report['rows']))
                save_json(report_path, report)
                print(json.dumps({'event': 'node', 'completed': len(report['rows']), 'total': len(nodes), 'node': node, 'ok': result.get('ok'), 'code': result.get('code'), 'stage': result.get('stage'), 'flags': result.get('diagnosticFlags', [])}, ensure_ascii=False), flush=True)
            if best:
                controller.select(best['node'])
                state.update(lastNode=best['node'], lastError=None)
                save_json(state_path, state)
                report['selectedWorkingNode'] = best['node']
            report['sharedSelectionsPreserved'] = selections(controller.request('GET', '/proxies')['proxies']) == baseline
            report['finished'] = len(report['rows']) == len(nodes)
            report['status'] = 'completed' if report['finished'] else report['status']
    except Exception as error:
        report.update(status='failed', errorCode=getattr(error, 'code', type(error).__name__))
    finally:
        if stopped:
            try:
                subprocess.run(['powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(launcher), '-DataDir', str(data_dir), '-Action', 'Start'], check=True)
                report['connectorRestarted'] = True
            except Exception:
                report['connectorRestarted'] = False
        report.update(endedAt=time.time(), completed=len(report['rows']), successCount=sum(r.get('ok', False) for r in report['rows']))
        save_json(report_path, report)
        print(json.dumps({k: v for k, v in report.items() if k not in ('rows', 'candidateNodes')}, ensure_ascii=False), flush=True)
    return 0 if report['finished'] and report.get('sharedSelectionsPreserved') and report.get('connectorRestarted') else 2


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--worker', type=Path)
    parser.add_argument('--video-id', default='sGpCq_VsDkc')
    parser.add_argument('--clash-config', type=Path)
    parser.add_argument('--data-dir', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--run-id')
    args = parser.parse_args()
    if args.worker:
        if not re.fullmatch(r'[A-Za-z0-9_-]{11}', args.video_id):
            raise SystemExit(2)
        probe(args.video_id, args.worker)
    else:
        if not all((args.clash_config, args.data_dir, args.report, args.run_id)):
            parser.error('需要明确配置路径、数据目录、报告和任务ID')
        try:
            with server.InstanceLock(args.data_dir / 'connector' / 'us-sweep.lock'):
                raise SystemExit(sweep(args.clash_config, args.data_dir, args.report, args.run_id))
        except PoolError as error:
            print(json.dumps({'started': False, 'errorCode': error.code}, ensure_ascii=False), flush=True)
            raise SystemExit(2)
