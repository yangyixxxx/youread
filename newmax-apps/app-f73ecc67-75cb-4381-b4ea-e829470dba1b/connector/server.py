"""Authenticated loopback YouTube connector. Standard-library HTTP/persistence only."""
from __future__ import annotations

import argparse
import copy
import hmac
import html
import json
import math
import os
import queue
import re
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

if __package__:
    from . import frame_worker as frames
else:
    # 手动入口使用 python -I，不把工作目录或任意搜索路径加入导入环境。
    import importlib.util
    _frame_spec = importlib.util.spec_from_file_location("yingdu_frame_worker", Path(__file__).with_name("frame_worker.py"))
    frames = importlib.util.module_from_spec(_frame_spec)
    _frame_spec.loader.exec_module(frames)

VERSION = "1.0.0"
HOST, PORT = "127.0.0.1", 18743
APP_DATA = Path("C:/Users/admin/.newmax/app-data/app-f73ecc67-75cb-4381-b4ea-e829470dba1b")
CHANNEL_ID = re.compile(r"UC[A-Za-z0-9_-]{22}\Z")
VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
MAX_CAPTION_BYTES = 8 * 1024 * 1024
MAX_SEGMENTS = 100000


class ConnectorError(Exception):
    def __init__(self, code, message, status=400, retryable=True):
        super().__init__(message)
        self.code, self.message, self.status, self.retryable = code, message, status, retryable


def normalize_channel(value):
    """Return a canonical input URL and a case-insensitive alias key; never accept videos."""
    if not isinstance(value, str) or not value.strip() or len(value) > 512:
        raise ConnectorError("INVALID_CHANNEL", "请输入 @频道名、UC 频道 ID 或 YouTube 频道链接。")
    value = unicodedata.normalize("NFC", value.strip())
    if any(ord(c) < 32 for c in value) or "\\" in value:
        raise ConnectorError("INVALID_CHANNEL", "频道链接包含不允许的字符，请重新复制频道主页链接。")
    if value.startswith("@"):
        path = "/" + value
    elif CHANNEL_ID.fullmatch(value):
        path = "/channel/" + value
    else:
        try:
            parsed = urlsplit(value)
            if (parsed.scheme not in ("http", "https") or parsed.hostname not in
                    ("youtube.com", "www.youtube.com", "m.youtube.com") or
                    parsed.username is not None or parsed.password is not None or
                    parsed.port is not None or parsed.query or parsed.fragment):
                raise ValueError()
            path = unquote(parsed.path, errors="strict").rstrip("/")
        except (ValueError, UnicodeError):
            raise ConnectorError("INVALID_CHANNEL", "仅支持 YouTube 频道主页链接，不接受视频、播放列表、参数或其他网站。") from None
    parts = path.strip("/").split("/")
    if parts[-1] in ("videos", "shorts", "streams", "featured") and len(parts) > 1:
        parts.pop()
    if len(parts) == 1 and parts[0].startswith("@"):
        name = parts[0][1:]
        if not 1 <= len(name) <= 30 or any(
            not (unicodedata.category(c)[0] in "LNM" or c in "._-·") for c in name
        ) or name[0] in ".-_·" or name[-1] in ".-_·":
            raise ConnectorError("INVALID_CHANNEL", "频道 handle 无效，请复制频道主页上的 @名称。")
        path = "/@" + name
        key = path.casefold()
    elif len(parts) == 2 and parts[0] == "channel" and CHANNEL_ID.fullmatch(parts[1]):
        path = "/channel/" + parts[1]
        key = path  # Channel IDs are case-sensitive.
    elif len(parts) == 2 and parts[0] in ("c", "user") and re.fullmatch(r"[A-Za-z0-9_-]{1,100}", parts[1]):
        path = "/" + "/".join(parts)
        key = path.casefold()
    else:
        raise ConnectorError("INVALID_CHANNEL", "这不是受支持的频道地址，请使用 @名称或 /channel/UC… 主页链接。")
    return "https://www.youtube.com" + path, key


def utc_iso(timestamp=None):
    return datetime.fromtimestamp(time.time() if timestamp is None else timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def finite_number(value, default=0):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) else default


def clean_text(value):
    text = re.sub(r"<[^>]*>", "", str(value))
    return " ".join(html.unescape(text).replace("\u200b", "").split())


def _segments_from_cues(cues):
    """Remove rolling-caption suffix/prefix overlap only across nearby cues."""
    result = []
    previous_text, previous_end = "", -100.0
    for start, end, text in sorted(cues, key=lambda cue: cue[0]):
        text = clean_text(text)
        if not text or start < 0 or end < start:
            continue
        original = text
        if result and start <= previous_end + 0.35:
            previous_words, words = previous_text.split(), text.split()
            overlap = 0
            for size in range(min(len(previous_words), len(words)), 0, -1):
                if previous_words[-size:] == words[:size]:
                    overlap = size
                    break
            if overlap:
                text = " ".join(words[overlap:])
            elif not re.search(r"[A-Za-z]", text + previous_text):
                # Chinese/Japanese rolling captions have no word separators.
                for size in range(min(len(previous_text), len(text)), 1, -1):
                    if previous_text[-size:] == text[:size]:
                        text = text[size:]
                        break
            if not text:
                result[-1]["end"] = max(result[-1]["end"], round(end, 3))
        if text:
            result.append({"start": round(start, 3), "end": round(end, 3), "text": text})
        previous_text, previous_end = original, end
        if len(result) > MAX_SEGMENTS:
            raise ConnectorError("CAPTIONS_TOO_LARGE", "字幕段落过多，请导入较短的文稿。", 422)
    return result


def parse_captions(raw, fmt):
    if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_CAPTION_BYTES:
        raise ConnectorError("CAPTIONS_TOO_LARGE", "字幕超过 8 MB 限额，可改为手动导入文稿。", 422)
    cues = []
    try:
        if fmt == "json3":
            data = json.loads(raw)
            for event in data.get("events", []):
                if not isinstance(event, dict) or not event.get("segs"):
                    continue
                start = finite_number(event.get("tStartMs"), -1000) / 1000
                duration = max(0, finite_number(event.get("dDurationMs"))) / 1000
                text = "".join(str(seg.get("utf8", "")) for seg in event["segs"] if isinstance(seg, dict))
                cues.append((start, start + duration, text))
        elif fmt == "vtt":
            def seconds(stamp):
                parts = stamp.replace(",", ".").split(":")
                return sum(float(part) * 60 ** index for index, part in enumerate(reversed(parts)))
            for block in re.split(r"\n\s*\n", raw.replace("\r\n", "\n").replace("\r", "\n").lstrip("\ufeff")):
                lines = block.splitlines()
                if not lines or lines[0].startswith(("NOTE", "STYLE", "REGION")):
                    continue
                for index, line in enumerate(lines):
                    match = re.match(r"\s*((?:\d+:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d+:)?\d{2}:\d{2}[.,]\d{3})", line)
                    if match:
                        cues.append((seconds(match[1]), seconds(match[2]), " ".join(lines[index + 1:])))
                        break
        else:
            raise ValueError()
        segments = _segments_from_cues(cues)
    except (ValueError, TypeError, KeyError, AttributeError, OverflowError):
        raise ConnectorError("CAPTIONS_INVALID", "字幕格式无法解析，请重试或手动导入 VTT/TXT 文稿。", 422) from None
    if not segments:
        raise ConnectorError("CAPTIONS_EMPTY", "字幕没有可阅读的内容，请重试或导入文稿。", 422)
    return segments


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".writing-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(value, handle, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


class YtDlpBackend:
    """One bounded subprocess per job; no shell, inherited cookie config, or raw logs."""
    def __init__(self, python=None):
        self.python = python or sys.executable
        self.active = None
        self.lock = threading.Lock()
        self.stopping = False

    def _call(self, action, url):
        with tempfile.TemporaryDirectory(prefix="newmax-youtube-") as folder:
            output = Path(folder) / "result.json"
            command = [self.python, "-I", str(Path(__file__).with_name("yt_worker.py")), action, url, str(output)]
            try:
                with self.lock:
                    if self.stopping:
                        raise ConnectorError("STOPPING", "连接器正在停止，重新启动后可重试。", 503)
                    process = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                               stderr=subprocess.DEVNULL, shell=False,
                                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    self.active = process
                try:
                    process.wait(timeout=75 if action == "channel" else 90)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=10)
                    raise ConnectorError("NETWORK_TIMEOUT", "YouTube 请求超时，请检查网络后点击重试。", 502) from None
                finally:
                    with self.lock:
                        self.active = None
                if not output.exists() or output.stat().st_size > 12 * 1024 * 1024:
                    raise ConnectorError("EXTRACTOR_FAILED", "无法获取 YouTube 数据，请检查网络及连接器依赖后重试。", 502)
                result = json.loads(output.read_text(encoding="utf-8"))
                if not result.get("ok"):
                    code = result.get("code", "NETWORK_ERROR")
                    messages = {
                        "DEPENDENCY_MISSING": "缺少 yt-dlp 依赖，请重新运行启动脚本安装后重试。",
                        "NO_CAPTIONS": "此视频暂无可用字幕，可稍后重试或手动导入文稿。",
                        "NETWORK_ERROR": "无法访问 YouTube 或内容受限，请检查网络后重试；也可导入文稿。",
                        "CAPTIONS_TOO_LARGE": "字幕超过 8 MB 限额，可改为手动导入文稿。",
                        "INVALID_RESPONSE": "YouTube 未返回有效频道数据，请核对频道并稍后重试。",
                    }
                    raise ConnectorError(code if code in messages else "EXTRACTOR_FAILED", messages.get(code, "获取失败，请检查网络后重试。"), 502)
                return result["data"]
            except (OSError, ValueError, KeyError, TypeError):
                raise ConnectorError("EXTRACTOR_FAILED", "连接器无法读取抓取结果，请检查 Python 环境并重试。", 502) from None

    def channel(self, url):
        return self._call("channel", url.rstrip("/") + "/videos")

    def captions(self, video_id):
        if not VIDEO_ID.fullmatch(video_id):
            raise ConnectorError("INVALID_VIDEO", "视频 ID 无效。", 400)
        return self._call("captions", "https://www.youtube.com/watch?v=" + video_id)

    def close(self):
        with self.lock:
            self.stopping = True
            if self.active is not None and self.active.poll() is None:
                self.active.kill()


class Library:
    def __init__(self, data_dir, backend=None, clock=time.time, frame_backend=None):
        self.directory = Path(data_dir)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / "library.json"
        self.backend, self.clock = backend or YtDlpBackend(), clock
        self.frame_backend = frame_backend if frame_backend is not None else frames.FrameBackend()
        # Ephemeral only: never journal/restart network work or persist signed URLs/JPEGs.
        self.frame_jobs = {}
        self.frame_cache_limit, self.frame_cache_ttl = 8, 60 * 60
        self.lock = threading.RLock()
        self.jobs, self.scheduled = queue.Queue(), set()
        self.stop_event = threading.Event()
        self.worker = None
        self.last_storage_error = None
        if self.path.exists():
            try:
                self.state = json.loads(self.path.read_text(encoding="utf-8"))
                self._validate_state()
            except (ValueError, KeyError, TypeError, OSError):
                raise ConnectorError("DATA_INVALID", "本地资料库无法读取，已保留原文件；请备份 connector/library.json 后修复，不会覆盖旧数据。", 500) from None
        else:
            self.state = {"schemaVersion": 1, "channels": [], "videos": [],
                          "settings": {"intervalMinutes": 30, "autoCaptions": True}, "lastSync": None}
        # A process may have stopped while a job was active. Persisted status is the queue journal.
        for channel in self.state["channels"]:
            if channel["status"] in ("pending", "syncing"):
                channel["status"] = "pending"
                self._queue("channel", channel["id"])
        for video in self.state["videos"]:
            if video["transcriptStatus"] in ("pending", "fetching"):
                video["transcriptStatus"] = "pending"
                self._queue("transcript", video["id"])
        self._save()

    def _validate_state(self):
        state = self.state
        if not isinstance(state, dict) or state.get("schemaVersion", 1) != 1:
            raise ValueError()
        for key in ("channels", "videos"):
            if not isinstance(state[key], list) or any(not isinstance(item, dict) for item in state[key]):
                raise ValueError()
            if len({item["id"] for item in state[key]}) != len(state[key]):
                raise ValueError()
        for item in state["channels"]:
            normalize_channel(item["url"])
            if item["status"] not in ("pending", "syncing", "ready", "error"):
                raise ValueError()
        for item in state["videos"]:
            if not VIDEO_ID.fullmatch(item["id"]) or item["transcriptStatus"] not in ("none", "pending", "fetching", "ready", "unavailable", "error"):
                raise ValueError()
        settings = state["settings"]
        self.validate_settings(settings)
        state.setdefault("lastSync", None)

    @staticmethod
    def validate_settings(settings):
        if not isinstance(settings, dict) or set(settings) - {"intervalMinutes", "autoCaptions"}:
            raise ConnectorError("INVALID_SETTINGS", "设置仅支持 intervalMinutes 与 autoCaptions。")
        if "intervalMinutes" in settings and (type(settings["intervalMinutes"]) is not int or not 5 <= settings["intervalMinutes"] <= 1440):
            raise ConnectorError("INVALID_SETTINGS", "同步间隔须为 5～1440 的整数分钟。")
        if "autoCaptions" in settings and type(settings["autoCaptions"]) is not bool:
            raise ConnectorError("INVALID_SETTINGS", "autoCaptions 必须是布尔值。")

    def _save(self):
        atomic_json(self.path, self.state)
        self.last_storage_error = None

    def _queue(self, kind, identifier):
        key = (kind, identifier)
        if key in self.scheduled:
            return False
        self.scheduled.add(key)
        self.jobs.put(key)
        return True

    def _channel(self, identifier):
        return next((item for item in self.state["channels"] if item["id"] == identifier), None)

    def _video(self, identifier):
        return next((item for item in self.state["videos"] if item["id"] == identifier), None)

    def snapshot(self):
        with self.lock:
            result = {"channels": [{k: v for k, v in item.items() if not k.startswith("_")} for item in self.state["channels"]],
                      "videos": [{k: v for k, v in item.items() if not k.startswith("_")} for item in self.state["videos"]],
                      "settings": self.state["settings"], "lastSync": self.state["lastSync"]}
            if self.last_storage_error:
                result["error"] = self.last_storage_error
            return copy.deepcopy(result)

    def add_channel(self, value):
        url, alias = normalize_channel(value)
        with self.lock:
            for channel in self.state["channels"]:
                if alias in channel.get("_aliases", [normalize_channel(channel["url"])[1]]) or url == channel.get("url"):
                    return {"ok": True, "channel": self._public(channel), "duplicate": True}
            if len(self.state["channels"]) >= 200:
                raise ConnectorError("CHANNEL_LIMIT", "最多订阅 200 个频道，请先取消不再需要的订阅。", 409)
            channel = {"id": uuid.uuid4().hex, "url": url, "title": url.rsplit("/", 1)[-1],
                       "youtubeId": None, "status": "pending", "error": None, "lastSync": None,
                       "_aliases": [alias], "_lastAttempt": None}
            self.state["channels"].append(channel)
            self._save()
            self._queue("channel", channel["id"])
            return {"ok": True, "channel": self._public(channel), "duplicate": False}

    @staticmethod
    def _public(item):
        return copy.deepcopy({k: v for k, v in item.items() if not k.startswith("_")})

    def sync(self, channel_id=None):
        with self.lock:
            targets = self.state["channels"] if channel_id is None else [self._channel(channel_id)]
            if targets == [None]:
                raise ConnectorError("CHANNEL_NOT_FOUND", "该频道已取消订阅，请刷新列表。", 404)
            enqueue = []
            for item in targets:
                if ("channel", item["id"]) not in self.scheduled:
                    item.update(status="pending", error=None)
                    enqueue.append(item["id"])
            self._save()
            for identifier in enqueue:
                self._queue("channel", identifier)
            return {"ok": True, "queued": len(enqueue)}

    def remove_channel(self, identifier):
        with self.lock:
            channel = self._channel(identifier)
            if channel is None:
                raise ConnectorError("CHANNEL_NOT_FOUND", "该频道已取消订阅，请刷新列表。", 404)
            self.state["channels"].remove(channel)
            self._save()
            return {"ok": True, "retainedVideos": True}

    def update_settings(self, settings):
        self.validate_settings(settings)
        with self.lock:
            self.state["settings"].update(settings)
            self._save()
            return {"ok": True, "settings": copy.deepcopy(self.state["settings"])}

    def request_transcript(self, identifier):
        with self.lock:
            video = self._video(identifier)
            if video is None:
                raise ConnectorError("VIDEO_NOT_FOUND", "找不到视频，请刷新列表。", 404)
            if video["transcriptStatus"] != "ready" and ("transcript", identifier) not in self.scheduled:
                video.update(transcriptStatus="pending", transcriptError=None)
                self._save()
                self._queue("transcript", identifier)
            return {"ok": True, "videoId": identifier, "status": video["transcriptStatus"]}

    def get_transcript(self, identifier):
        with self.lock:
            video = self._video(identifier)
            if video is None:
                raise ConnectorError("VIDEO_NOT_FOUND", "找不到视频，请刷新列表。", 404)
            if video["transcriptStatus"] != "ready":
                raise ConnectorError("TRANSCRIPT_NOT_READY", video.get("transcriptError") or "字幕尚未就绪，请获取字幕或稍后刷新。", 409)
            try:
                path = self.directory / "transcripts" / (identifier + ".json")
                if path.stat().st_size > 32 * 1024 * 1024:
                    raise ValueError()
                transcript = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(transcript.get("segments"), list):
                    raise ValueError()
                return transcript
            except (OSError, ValueError, AttributeError):
                video.update(transcriptStatus="error", transcriptError="字幕文件丢失或损坏，请重新获取或导入文稿。")
                self._save()
                raise ConnectorError("TRANSCRIPT_FILE_ERROR", video["transcriptError"], 409) from None

    def frame_capability(self):
        return self.frame_backend.capability()

    def _expire_frames(self):
        now = self.clock()
        for identifier, job in list(self.frame_jobs.items()):
            ended = job.get("_ended")
            if ended is not None and (now - ended >= self.frame_cache_ttl or ended > now + self.frame_cache_ttl):
                del self.frame_jobs[identifier]

    def request_frames(self, identifier, body):
        if not isinstance(body, dict) or set(body) != {"times"}:
            raise ConnectorError("INVALID_FRAMES", "截图请求仅支持 times 秒数数组，不接受 URL、凭据或自定义命令。")
        times = body["times"]
        if not isinstance(times, list) or not times:
            raise ConnectorError("INVALID_FRAMES", "请选择 1～5 个不同的截图时间点。")
        # Validate before deduplicating (bool/NaN/infinity/strings are never seconds).
        if any(not frames.number(value) or not 0 <= value <= frames.MAX_SECONDS for value in times):
            raise ConnectorError("INVALID_FRAMES", "截图时间必须是有限非负秒数，且不能超过 12 小时。")
        times = sorted(set(times))
        if len(times) > 5:
            raise ConnectorError("INVALID_FRAMES", "每次最多获取 5 个不同的截图时间点。")
        with self.lock:
            self._expire_frames()
            video = self._video(identifier) if isinstance(identifier, str) and VIDEO_ID.fullmatch(identifier) else None
            if video is None:
                raise ConnectorError("VIDEO_NOT_FOUND", "找不到资料库中的视频，请刷新列表后重试。", 404)
            duration = video.get("duration")
            if frames.number(duration) and duration >= 0 and any(value >= duration for value in times):
                raise ConnectorError("FRAME_OUT_OF_RANGE", "截图时间须早于视频结束时间，请选择更早的时间点。")
            if self.stop_event.is_set():
                raise ConnectorError("STOPPING", frames.MESSAGES["STOPPING"], 503)
            for job in self.frame_jobs.values():
                if job["status"] in ("queued", "running"):
                    if job["videoId"] == identifier and job["_times"] == times:
                        return {"ok": True, "job": self._public(job)}
                    raise ConnectorError("FRAMES_BUSY", "另一个视频截图任务正在排队或处理中，请等待完成后再试。", 409)
            capability = self.frame_capability()
            if not capability["capabilities"]["videoFrames"]:
                raise ConnectorError("FRAMES_UNAVAILABLE", capability.get("frameReason") or "视频截图暂不可用，请检查依赖后重试。", 503)
            # Bound total JPEG memory even if many completed jobs have not expired.
            while len(self.frame_jobs) >= self.frame_cache_limit:
                del self.frame_jobs[next(iter(self.frame_jobs))]
            job = {"id": uuid.uuid4().hex, "videoId": identifier, "status": "queued",
                   "items": [{"seconds": value, "status": "pending"} for value in times], "_times": times}
            self.frame_jobs[job["id"]] = job
            self._queue("frames", job["id"])
            return {"ok": True, "job": self._public(job)}

    def get_frame_job(self, identifier):
        with self.lock:
            self._expire_frames()
            job = self.frame_jobs.get(identifier)
            if job is None:
                raise ConnectorError("FRAME_JOB_NOT_FOUND", "截图任务不存在、已过期或连接器已重启，请重新获取截图。", 404)
            return {"ok": True, "job": self._public(job)}

    def _frame_failure(self, identifier, message):
        with self.lock:
            job = self.frame_jobs.get(identifier)
            if job:
                for item in job["items"]:
                    if item["status"] in ("pending", "running"):
                        item.update(status="error", error=message)
                job.update(status="error", error=message, _ended=self.clock())

    def _process_frames(self, identifier):
        with self.lock:
            job = self.frame_jobs.get(identifier)
            if job is None or job["status"] != "queued":
                return
            if self.stop_event.is_set():
                raise frames.FrameError("STOPPING")
            job["status"] = "running"
            video_id = job["videoId"]
        source = self.frame_backend.source(video_id)
        for item in job["items"]:
            if self.stop_event.is_set():
                raise frames.FrameError("STOPPING")
            with self.lock:
                item["status"] = "running"
            try:
                result = self.frame_backend.capture(source, item["seconds"])
                # Validate at the queue boundary as well; only generated JPEGs can be ready.
                data_url = result.get("dataUrl") if isinstance(result, dict) else None
                prefix = "data:image/jpeg;base64,"
                if not isinstance(data_url, str) or not data_url.startswith(prefix) or len(data_url) > frames.MAX_JPEG_BYTES * 4 // 3 + 32:
                    raise frames.FrameError("INVALID_IMAGE")
                raw = frames.base64.b64decode(data_url[len(prefix):], validate=True)
                width, height = frames.jpeg_dimensions(raw)
                with self.lock:
                    if self.stop_event.is_set():
                        raise frames.FrameError("STOPPING")
                    item.update(status="ready", dataUrl=data_url, width=width, height=height)
            except Exception as error:
                message = error.message if isinstance(error, frames.FrameError) else frames.MESSAGES["INVALID_IMAGE"]
                with self.lock:
                    item.update(status="error", error=message)
        with self.lock:
            failed = sum(item["status"] != "ready" for item in job["items"])
            job.update(status="error" if failed else "done", _ended=self.clock())
            if failed:
                job["error"] = f"{failed} 张截图未能获取；已成功的图片仍可选择，请检查网络或更换时间点后手动重试。"

    def schedule_due(self):
        with self.lock:
            self._expire_frames()
            now = self.clock()
            interval = self.state["settings"]["intervalMinutes"] * 60
            identifiers = []
            for channel in self.state["channels"]:
                last = channel.get("_lastAttempt")
                if ((last is None or now - last >= interval or last > now + interval)
                        and ("channel", channel["id"]) not in self.scheduled):
                    channel.update(status="pending", error=None)
                    identifiers.append(channel["id"])
            if identifiers:
                self._save()
                for identifier in identifiers:
                    self._queue("channel", identifier)
            return len(identifiers)

    def _process_channel(self, identifier):
        with self.lock:
            channel = self._channel(identifier)
            if channel is None:
                return
            channel.update(status="syncing", error=None, _lastAttempt=self.clock())
            self._save()
            url = channel["url"]
        result = self.backend.channel(url)
        youtube_id = result.get("youtubeId")
        if not isinstance(youtube_id, str) or not CHANNEL_ID.fullmatch(youtube_id) or not isinstance(result.get("videos"), list):
            raise ConnectorError("INVALID_RESPONSE", "YouTube 未返回有效频道信息，请检查频道地址后重试。", 502)
        with self.lock:
            channel = self._channel(identifier)
            if channel is None:  # Cancellation during a network call must not resurrect the subscription.
                return
            canonical = next((item for item in self.state["channels"] if item["id"] != identifier and item.get("youtubeId") == youtube_id), None)
            if canonical:
                canonical["_aliases"] = sorted(set(canonical.get("_aliases", []) + channel.get("_aliases", [])))
                self.state["channels"].remove(channel)
                for video in self.state["videos"]:
                    if video["channelId"] == identifier:
                        video["channelId"] = canonical["id"]
                channel = canonical
            canonical_url = "https://www.youtube.com/channel/" + youtube_id
            channel.update(youtubeId=youtube_id, title=str(result.get("title") or channel["title"])[:500],
                           url=canonical_url, status="ready", error=None, lastSync=utc_iso(self.clock()), _lastAttempt=self.clock())
            # 头像由受控 worker 筛选；缺失时保留上次结果，兼容旧订阅数据。
            avatar = result.get("avatar")
            if isinstance(avatar, str) and 0 < len(avatar) <= 4096:
                channel["avatar"] = avatar
            channel["_aliases"] = sorted(set(channel.get("_aliases", []) + ["/channel/" + youtube_id]))
            for discovered in result.get("aliases", []):
                try:
                    channel["_aliases"] = sorted(set(channel["_aliases"] + [normalize_channel(discovered)[1]]))
                except ConnectorError:
                    pass
            new_videos = []
            for entry in result["videos"][:20]:
                if not isinstance(entry, dict) or not isinstance(entry.get("id"), str) or not VIDEO_ID.fullmatch(entry["id"]):
                    continue
                video = self._video(entry["id"])
                if video is None:
                    video = {"id": entry["id"], "transcriptStatus": "none", "transcriptError": None}
                    self.state["videos"].append(video)
                    new_videos.append(video)
                video.update(title=str(entry.get("title") or entry["id"])[:1000], channelId=channel["id"],
                             channelTitle=channel["title"], url="https://www.youtube.com/watch?v=" + entry["id"],
                             publishedAt=entry.get("publishedAt"), duration=entry.get("duration"),
                             thumbnail=entry.get("thumbnail"), _youtubeChannelId=youtube_id)
            # Relink retained older videos when a previously removed channel is subscribed again.
            for video in self.state["videos"]:
                if video.get("_youtubeChannelId") == youtube_id:
                    video.update(channelId=channel["id"], channelTitle=channel["title"])
            auto = new_videos[:3] if self.state["settings"]["autoCaptions"] else []
            for video in auto:
                video.update(transcriptStatus="pending", transcriptError=None)
            self.state["lastSync"] = channel["lastSync"]
            self._save()
            for video in auto:
                self._queue("transcript", video["id"])

    def _process_transcript(self, identifier):
        with self.lock:
            video = self._video(identifier)
            if video is None or video["transcriptStatus"] == "ready":
                return
            video.update(transcriptStatus="fetching", transcriptError=None)
            self._save()
        result = self.backend.captions(identifier)
        raw, fmt = result["raw"], result["format"]
        transcript = {"segments": parse_captions(raw, fmt), "language": result.get("language", "unknown"),
                      "source": result.get("source", "youtube"), "raw": raw, "format": fmt}
        with self.lock:
            atomic_json(self.directory / "transcripts" / (identifier + ".json"), transcript)
            self._video(identifier).update(transcriptStatus="ready", transcriptError=None)
            self._save()

    def process_next(self, timeout=0):
        try:
            kind, identifier = self.jobs.get(timeout=timeout)
        except queue.Empty:
            return False
        try:
            if kind == "channel":
                self._process_channel(identifier)
            elif kind == "frames":
                self._process_frames(identifier)
            else:
                self._process_transcript(identifier)
        except Exception as error:
            if kind == "frames":
                message = error.message if isinstance(error, frames.FrameError) else frames.MESSAGES["PROCESS_ERROR"]
                self._frame_failure(identifier, message)
                return True
            message = error.message if isinstance(error, ConnectorError) else "同步失败，请检查网络或本地存储后点击重试。"
            with self.lock:
                item = self._channel(identifier) if kind == "channel" else self._video(identifier)
                if item:
                    if self.stop_event.is_set():
                        if kind == "channel":
                            item.update(status="pending", error=None)
                        else:
                            item.update(transcriptStatus="pending", transcriptError=None)
                    elif kind == "channel":
                        item.update(status="error", error=message, _lastAttempt=self.clock())
                    else:
                        status = "unavailable" if isinstance(error, ConnectorError) and error.code == "NO_CAPTIONS" else "error"
                        item.update(transcriptStatus=status, transcriptError=message)
                    try:
                        self._save()
                    except Exception:
                        self.last_storage_error = "无法写入本地资料库，请检查磁盘空间或文件权限后重试。"
        finally:
            with self.lock:
                self.scheduled.discard((kind, identifier))
            self.jobs.task_done()
        return True

    def _work(self):
        next_schedule = 0
        while not self.stop_event.is_set():
            if time.monotonic() >= next_schedule:
                try:
                    self.schedule_due()
                except Exception:
                    self.last_storage_error = "定时检查暂时失败，请检查本地存储权限后重试。"
                next_schedule = time.monotonic() + 15
            self.process_next(timeout=0.5)

    def start(self):
        if self.worker and self.worker.is_alive():
            return
        self.worker = threading.Thread(target=self._work, name="youtube-single-worker", daemon=True)
        self.worker.start()

    def close(self):
        self.stop_event.set()
        self.frame_backend.close()
        with self.lock:
            for identifier, job in self.frame_jobs.items():
                if job["status"] in ("queued", "running"):
                    self._frame_failure(identifier, frames.MESSAGES["STOPPING"])
        close = getattr(self.backend, "close", None)
        if close:
            close()
        if self.worker:
            self.worker.join(timeout=12)


def allowed_origin(origin):
    if origin == "null":
        return True
    try:
        parsed = urlsplit(origin)
        return (parsed.scheme in ("http", "https") and parsed.hostname in ("127.0.0.1", "localhost", "::1")
                and parsed.username is None and parsed.password is None and not parsed.path
                and not parsed.query and not parsed.fragment and (parsed.port is None or 1 <= parsed.port <= 65535))
    except (ValueError, TypeError):
        return False


class ConnectorHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False
    request_queue_size = 16

    def __init__(self, address, library, token):
        if address[0] != HOST:
            raise ValueError("Only 127.0.0.1 is allowed")
        self.library, self.token = library, token
        self.request_slots = threading.BoundedSemaphore(16)
        super().__init__(address, Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()

    def handle_error(self, request, client_address):
        pass  # Never log request headers, tokens, external URLs, or tracebacks.


class Handler(BaseHTTPRequestHandler):
    server_version = "LocalYouTubeConnector/" + VERSION
    sys_version = ""

    def log_message(self, format, *args):
        pass

    def _send(self, status, payload=None, preflight=False):
        body = b"" if payload is None else json.dumps(payload, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        origin = self.headers.get("Origin")
        if origin and allowed_origin(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            if preflight:
                self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
                self.send_header("Access-Control-Max-Age", "600")
                if self.headers.get("Access-Control-Request-Private-Network") == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.close_connection = True
        if body and self.command != "HEAD":
            self.wfile.write(body)

    def _gate(self, authenticate=True):
        expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if self.headers.get_all("Host", []) not in ([value] for value in expected):
            raise ConnectorError("INVALID_HOST", "仅允许通过本机回环地址访问连接器。", 403, False)
        origins = self.headers.get_all("Origin", [])
        if len(origins) > 1 or (origins and not allowed_origin(origins[0])):
            raise ConnectorError("ORIGIN_DENIED", "当前页面不允许访问本地连接器，请从本地应用打开。", 403, False)
        if authenticate:
            values = self.headers.get_all("Authorization", [])
            wanted = "Bearer " + self.server.token
            if len(values) != 1 or not hmac.compare_digest(values[0].encode("utf-8"), wanted.encode("utf-8")):
                raise ConnectorError("UNAUTHORIZED", "连接器凭据无效或已更新，请重新连接本地服务。", 401)

    def _body(self, optional=False):
        if self.headers.get("Transfer-Encoding") or len(self.headers.get_all("Content-Length", [])) > 1:
            raise ConnectorError("INVALID_BODY", "不支持此请求编码。", 400)
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ConnectorError("INVALID_BODY", "请求长度无效。", 400) from None
        if not 0 <= length <= 8192:
            raise ConnectorError("BODY_TOO_LARGE", "请求内容超过 8 KB 限额。", 413)
        if length == 0 and optional:
            return {}
        if self.headers.get("Content-Type", "").split(";")[0].strip().lower() != "application/json":
            raise ConnectorError("INVALID_BODY", "请使用 JSON 请求内容。", 415)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            if not isinstance(body, dict):
                raise ValueError()
            return body
        except (ValueError, UnicodeError):
            raise ConnectorError("INVALID_JSON", "请求 JSON 无效，请刷新应用后重试。", 400) from None

    def _route(self):
        self._gate()
        if "?" in self.path or "#" in self.path or not self.path.startswith("/"):
            raise ConnectorError("NOT_FOUND", "接口不存在，请刷新应用。", 404, False)
        method, path, library = self.command, self.path, self.server.library
        if method == "GET" and path == "/health":
            return 200, {"ok": True, "version": VERSION,
                         "workerRunning": bool(library.worker and library.worker.is_alive()),
                         "pid": os.getpid(), "background": getattr(self.server, "background", False),
                         **library.frame_capability()}
        if method == "POST" and path == "/shutdown":
            self._body()
            # shutdown 必须从服务循环之外调用；finally 会停止 worker 并保留队列。
            threading.Thread(target=self.server.shutdown, daemon=True).start()
            return 200, {"ok": True, "stopping": True}
        if method == "GET" and path == "/library":
            return 200, library.snapshot()
        if method == "POST" and path == "/channels":
            body = self._body()
            if set(body) != {"url"}:
                raise ConnectorError("INVALID_BODY", "新增频道需要且仅需要 url 字段。")
            return 202, library.add_channel(body["url"])
        if method == "POST" and path == "/sync":
            body = self._body(optional=True)
            if set(body) - {"channelId"} or (body.get("channelId") is not None and not isinstance(body["channelId"], str)):
                raise ConnectorError("INVALID_BODY", "channelId 必须是频道标识字符串。")
            return 202, library.sync(body.get("channelId"))
        if method == "PATCH" and path == "/settings":
            return 200, library.update_settings(self._body())
        match = re.fullmatch(r"/channels/([A-Za-z0-9_-]{1,100})", path)
        if method == "DELETE" and match:
            return 200, library.remove_channel(match[1])
        match = re.fullmatch(r"/videos/([A-Za-z0-9_-]{11})/frames", path)
        if match and method == "POST":
            return 202, library.request_frames(match[1], self._body())
        match = re.fullmatch(r"/frame-jobs/([a-f0-9]{32})", path)
        if match and method == "GET":
            return 200, library.get_frame_job(match[1])
        match = re.fullmatch(r"/videos/([A-Za-z0-9_-]{11})/transcript", path)
        if match and method == "GET":
            return 200, library.get_transcript(match[1])
        if match and method == "POST":
            self._body(optional=True)
            return 202, library.request_transcript(match[1])
        raise ConnectorError("NOT_FOUND", "接口不存在或请求方法不支持，请刷新应用。", 404, False)

    def _dispatch(self):
        try:
            if self.command == "OPTIONS":
                # Browser preflight never contains Authorization. This exception exposes no data.
                self._gate(authenticate=False)
                if self.headers.get("Access-Control-Request-Method") not in ("GET", "POST", "PATCH", "DELETE"):
                    raise ConnectorError("PREFLIGHT_DENIED", "请求方法不受支持。", 403, False)
                requested = {item.strip().lower() for item in self.headers.get("Access-Control-Request-Headers", "").split(",") if item.strip()}
                if not self.headers.get("Origin") or requested - {"authorization", "content-type"}:
                    raise ConnectorError("PREFLIGHT_DENIED", "请求来源或请求头不受支持。", 403, False)
                self._send(204, preflight=True)
                return
            status, payload = self._route()
            self._send(status, payload)
        except ConnectorError as error:
            self._send(error.status, {"ok": False, "code": error.code, "error": error.message, "retryable": error.retryable})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            return
        except Exception:
            self._send(500, {"ok": False, "code": "LOCAL_ERROR", "error": "本地连接器处理失败，请检查磁盘权限并重试。", "retryable": True})

    do_GET = do_POST = do_PATCH = do_DELETE = do_OPTIONS = do_HEAD = do_PUT = do_TRACE = do_CONNECT = _dispatch


class InstanceLock:
    def __init__(self, path):
        self.path, self.handle = Path(path), None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(self.path, "a+b")
        self.handle.seek(0, os.SEEK_END)
        if self.handle.tell() == 0:
            self.handle.write(b"0")
            self.handle.flush()
        self.handle.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.handle.close()
            raise ConnectorError("ALREADY_RUNNING", "连接器已在运行，请使用原窗口；无需重复启动。", 409) from None
        return self

    def __exit__(self, *args):
        if self.handle:
            self.handle.close()


def connection_token(path):
    if path.exists():
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            token = value["token"]
            if not isinstance(token, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", token):
                raise ValueError()
            return token
        except (ValueError, KeyError, TypeError, OSError):
            raise ConnectorError("CONNECTION_INVALID", "连接配置损坏，已保留原文件；请备份并移走 connector/connection.json 后重启。", 500) from None
    return secrets.token_urlsafe(32)


def main(argv=None):
    parser = argparse.ArgumentParser(description="本机 YouTube 连接器（支持静默登录启动）")
    parser.add_argument("--data-dir", type=Path, default=APP_DATA, help="应用数据目录；测试可指定临时目录")
    parser.add_argument("--background", action="store_true", help="标记无控制台运行模式")
    args = parser.parse_args(argv)
    directory = args.data_dir / "connector"
    try:
        with InstanceLock(directory / "instance.lock"):
            token = connection_token(directory / "connection.json")
            library = Library(directory)
            try:
                server = ConnectorHTTPServer((HOST, PORT), library, token)
            except OSError:
                library.close()
                raise ConnectorError("PORT_BUSY", "本机端口 18743 已被占用，请关闭原连接器或占用程序后重试。", 409) from None
            try:
                atomic_json(directory / "connection.json", {"url": f"http://{HOST}:{PORT}", "token": token})
                server.background = args.background
                library.start()
                print("YouTube 本地连接器已启动，仅监听 127.0.0.1:18743。可通过应用设置停止后台更新。", flush=True)
                server.serve_forever(poll_interval=0.5)
            except KeyboardInterrupt:
                print("正在停止连接器，待处理任务会在下次启动恢复。", flush=True)
            finally:
                server.server_close()
                library.close()
    except ConnectorError as error:
        print(error.message, file=sys.stderr)
        return 1
    except Exception:
        print("连接器启动失败，请检查 Python 环境、磁盘空间与数据目录权限。未输出敏感日志。", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
