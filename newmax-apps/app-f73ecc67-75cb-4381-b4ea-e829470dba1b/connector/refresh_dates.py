"""经认证请求当前库日期补取并记录结果；令牌只在内存使用，不输出。"""
import argparse
import hashlib
import json
import re
import time
from collections import Counter
from pathlib import Path
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError("本机连接器不允许重定向")


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def protected_hashes(data_dir):
    kv = json.loads((data_dir / "kv.json").read_text(encoding="utf-8"))
    entries = kv.get("entries", {})
    # 资料库缓存是日期补取的预期变化，不纳入正文/笔记保护比较。
    if not isinstance(entries, dict):
        raise RuntimeError("未知的资料存储结构；未发起请求")
    # 宿主读取后重新保存缓存会更新updatedAt；只比较实际value，仍检测正文变化。
    result = {"kv:" + key: digest(value.get("value", value) if isinstance(value, dict) else value)
              for key, value in entries.items() if key != "yingdu.library-cache.v1"}
    for folder in (data_dir / "connector" / "transcripts", data_dir / "editorial"):
        if folder.exists():
            for path in folder.rglob("*"):
                if path.is_file():
                    result[str(path.relative_to(data_dir))] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def run(data_dir, report_path, missing_only=False):
    config = json.loads((data_dir / "connector" / "connection.json").read_text(encoding="utf-8"))
    if config.get("url") != "http://127.0.0.1:18743" or not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", config.get("token", "")):
        raise RuntimeError("本地连接配置无效；未发起请求")
    opener = build_opener(ProxyHandler({}), NoRedirect())

    def request(path, post=False):
        payload = json.dumps({"missingOnly": True} if missing_only else {}).encode()
        req = Request(config["url"] + path, data=payload if post else None,
                      headers={"Authorization": "Bearer " + config["token"], "Content-Type": "application/json"})
        with opener.open(req, timeout=10) as response:
            return json.load(response)

    original = request("/library")
    before = protected_hashes(data_dir)
    targets = {video["id"] for video in original["videos"] if not missing_only or not video.get("publishedAt") or video.get("datePrecision") == "approximate"}
    queued = request("/dates/refresh", post=True)
    print(json.dumps({"started": queued}, ensure_ascii=False), flush=True)
    deadline = time.monotonic() + max(180, len(targets) * 95 + 180)
    previous = None
    while True:
        library = request("/library")
        videos = [v for v in library["videos"] if v["id"] in targets]
        counts = dict(Counter(v.get("dateStatus", "unknown") for v in videos))
        after = None
        done = len(videos) == len(targets) and all(v.get("dateStatus") in ("ready", "error", "unavailable") for v in videos)
        if done:
            after = protected_hashes(data_dir)
        result = {
            "finished": done, "total": len(targets), "counts": counts,
            "dated": sum(bool(v.get("publishedAt")) for v in videos),
            "rows": [{k: v.get(k) for k in ("id", "title", "channelTitle", "publishedAt", "dateStatus", "dateError")} for v in videos],
            "protectedFiles": len(before),
            "protectedUnchanged": before == after if done else None,
            "changedProtectedKeys": sorted(k for k in set(before) | set(after or {}) if before.get(k) != (after or {}).get(k)) if done else [],
            "originalVideoIdsRetained": targets.issubset({v["id"] for v in library["videos"]}),
            "originalChannelIdsRetained": {c["id"] for c in original["channels"]}.issubset({c["id"] for c in library["channels"]}),
        }
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        if counts != previous:
            print(json.dumps({"counts": counts, "dated": result["dated"], "finished": done}, ensure_ascii=False), flush=True)
            previous = counts
        if done:
            print(json.dumps({k: v for k, v in result.items() if k != "rows"}, ensure_ascii=False), flush=True)
            return 0 if counts.get("ready", 0) == len(targets) and result["protectedUnchanged"] else 2
        if time.monotonic() > deadline:
            print("观察等待已到上限；后台队列仍保留，详见结果文件。", flush=True)
            return 3
        time.sleep(5)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="显式刷新映读全库视频日期")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--missing-only", action="store_true", help="只补缺失或近似日期，不重复查询确切日期")
    args = parser.parse_args()
    try:
        raise SystemExit(run(args.data_dir, args.report, missing_only=args.missing_only))
    except (OSError, ValueError, RuntimeError):
        print("日期操作未完成；请检查本地服务及资料目录。未输出令牌或原始异常。", flush=True)
        raise SystemExit(1)
