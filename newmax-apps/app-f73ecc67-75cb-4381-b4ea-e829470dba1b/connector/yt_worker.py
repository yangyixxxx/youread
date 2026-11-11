"""Short-lived yt-dlp library adapter. Invoked by server.py with argument arrays only."""
from __future__ import annotations

import itertools
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener, ProxyHandler
from urllib.error import HTTPError
from email.utils import parsedate_to_datetime

LIMIT = 8 * 1024 * 1024


class SafeFailure(Exception):
    pass


class QuietLogger:
    def debug(self, *args, **kwargs):
        pass
    info = warning = error = debug


def options(action, proxy=None):
    result = {
        "quiet": True, "no_warnings": True, "logger": QuietLogger(), "noprogress": True,
        "skip_download": True, "cachedir": False, "socket_timeout": 12,
        "retries": 1, "extractor_retries": 1, "fragment_retries": 0,
        "ignoreerrors": False, "noplaylist": action != "channel",
        "cookiefile": None, "cookiesfrombrowser": None, "usenetrc": False,
        "writeinfojson": False, "writethumbnail": False, "writesubtitles": False,
        "writeautomaticsub": False, "ignore_no_formats_error": True,
        "js_runtimes": {"node": {}}, "remote_components": set(),
        "extractor_args": {"youtube": {"skip": ["hls", "dash", "translated_subs"]}},
    }
    if action == "channel":
        result.update(extract_flat="in_playlist", playlistend=20, playlist_items="1:20", lazy_playlist=True)
        # yt-dlp 以本次抓取时刻转换“1 hour ago”等文案；这里只作为近似排序依据。
        result["extractor_args"]["youtubetab"] = {"approximate_date": ["true"]}
    if action == "captions":
        result.update(retries=0, extractor_retries=0)
    if proxy is not None:
        result["proxy"] = proxy
    return result


def retry_after_seconds(headers):
    raw = headers.get("Retry-After", "") if headers else ""
    try:
        seconds = int(raw) if str(raw).isdigit() else (parsedate_to_datetime(raw) - datetime.now(timezone.utc)).total_seconds()
        return min(86400, max(0, int(seconds)))
    except (ValueError, TypeError, OverflowError):
        return 0


def safe_caption_url(url):
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == "https" and parsed.username is None and parsed.password is None
                and parsed.port in (None, 443) and parsed.hostname is not None
                and any(parsed.hostname == host or parsed.hostname.endswith("." + host)
                        for host in ("youtube.com", "googlevideo.com")))
    except (ValueError, TypeError):
        return False


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if not safe_caption_url(newurl):
            raise SafeFailure("NETWORK_ERROR")
        return super().redirect_request(request, fp, code, message, headers, newurl)


def choose_track(info):
    candidates = []
    for source, group in (("manual", info.get("subtitles") or {}), ("automatic", info.get("automatic_captions") or {})):
        for language, tracks in group.items():
            lower = language.lower()
            if lower == "live_chat":
                continue
            language_rank = 0 if lower.startswith(("zh", "cmn")) else 1 if lower.startswith("en") else 2
            for track in tracks or []:
                if track.get("ext") not in ("json3", "vtt") or not safe_caption_url(track.get("url")):
                    continue
                if source == "automatic" and parse_qs(urlsplit(track["url"]).query).get("tlang"):
                    continue  # Do not silently prefer a machine translation over original speech captions.
                # Prefer Chinese/English, then human-authored, then json3.
                rank = (language_rank, source != "manual", track["ext"] != "json3", language)
                candidates.append((rank, language, source, track))
    if not candidates:
        raise SafeFailure("NO_CAPTIONS")
    _, language, source, track = min(candidates, key=lambda item: item[0])
    return language, source, track


def fetch_captions(info, proxy=None):
    if not info.get("subtitles") and not info.get("automatic_captions") and not info.get("formats") and info.get("duration") is None:
        raise SafeFailure("CAPTION_LIST_UNAVAILABLE")
    language, source, track = choose_track(info)
    request = Request(track["url"], headers={"User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity"})
    handlers = [SafeRedirect()]
    if proxy is not None:
        handlers.append(ProxyHandler({"http": proxy, "https": proxy}))
    with build_opener(*handlers).open(request, timeout=12) as response:
        if not safe_caption_url(response.url):
            raise SafeFailure("NETWORK_ERROR")
        content_length = response.headers.get("Content-Length")
        if content_length and int(content_length) > LIMIT:
            raise SafeFailure("CAPTIONS_TOO_LARGE")
        raw = response.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise SafeFailure("CAPTIONS_TOO_LARGE")
    return {"language": language, "source": source, "format": track["ext"], "raw": raw.decode("utf-8-sig"),
            **publication_metadata(info)}


def safe_avatar_url(url):
    if not isinstance(url, str) or len(url) > 4096 or re.search(r"[\x00-\x20\x7f]", url):
        return False
    try:
        parsed = urlsplit(url)
        return (parsed.scheme == "https" and parsed.username is None and parsed.password is None
                and parsed.port in (None, 443) and parsed.hostname is not None
                and any(parsed.hostname == host or parsed.hostname.endswith("." + host)
                        for host in ("ggpht.com", "googleusercontent.com", "ytimg.com")))
    except (ValueError, TypeError):
        return False


def channel_avatar(info):
    # yt-dlp 同时返回头像与横幅；只选已标注头像或方形频道图片。
    candidates = []
    for image in info.get("thumbnails") or []:
        if not isinstance(image, dict) or not safe_avatar_url(image.get("url")):
            continue
        label = str(image.get("id", "")).lower()
        if "banner" in label or image.get("preference", 0) in (-10, -5):
            continue
        width, height = image.get("width"), image.get("height")
        square = (isinstance(width, (int, float)) and isinstance(height, (int, float))
                  and not isinstance(width, bool) and not isinstance(height, bool)
                  and math.isfinite(width) and math.isfinite(height) and 0 < width == height)
        if "avatar" in label or square:
            candidates.append(("avatar" in label, min(width, 512) if square else 0, image["url"]))
    return max(candidates, default=(False, 0, ""))[2]


def publication_date(info):
    """只接受详情中的绝对日期；无精确时刻时沿用日期零点表示。"""
    value = info.get("timestamp")
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0:
        try:
            return datetime.fromtimestamp(value, timezone.utc).isoformat().replace("+00:00", "Z")
        except (ValueError, OSError, OverflowError):
            pass
    value = info.get("upload_date")
    if isinstance(value, str) and re.fullmatch(r"\d{8}", value):
        try:
            return datetime.strptime(value, "%Y%m%d").replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")
        except ValueError:
            pass
    return None


def publication_metadata(info, approximate=False):
    value = publication_date(info)
    if not value:
        return {"publishedAt": None, "datePrecision": None}
    timestamp = info.get("timestamp")
    precision = "second" if isinstance(timestamp, (int, float)) and not isinstance(timestamp, bool) and math.isfinite(timestamp) and 0 < timestamp < 253402300800 else "day"
    return {"publishedAt": value, "datePrecision": "approximate" if approximate else precision}


def video_metadata(info):
    duration = info.get("duration")
    if not isinstance(duration, (int, float)) or isinstance(duration, bool) or not math.isfinite(duration) or duration < 0:
        duration = None
    return {**publication_metadata(info), "title": str(info.get("title") or "")[:1000],
            "channelTitle": str(info.get("channel") or info.get("uploader") or "YouTube")[:500],
            "youtubeId": info.get("channel_id"), "duration": duration}


def channel_result(info):
    youtube_id = info.get("channel_id") or info.get("id")
    if not isinstance(youtube_id, str) or not re.fullmatch(r"UC[A-Za-z0-9_-]{22}", youtube_id):
        raise SafeFailure("INVALID_RESPONSE")
    videos = []
    seen = set()
    for entry in itertools.islice(info.get("entries") or [], 20):
        if not isinstance(entry, dict):
            continue
        video_id = entry.get("id")
        if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id) or video_id in seen:
            continue
        seen.add(video_id)
        published = publication_metadata(entry, approximate=True)
        duration = entry.get("duration")
        if not isinstance(duration, (float, int)) or isinstance(duration, bool) or not math.isfinite(duration) or duration < 0:
            duration = None
        videos.append({"id": video_id, "title": str(entry.get("title") or video_id)[:1000],
                       **published, "duration": duration,
                       "thumbnail": "https://i.ytimg.com/vi/" + video_id + "/mqdefault.jpg"})
    aliases = [info.get(key) for key in ("uploader_url", "channel_url", "webpage_url") if isinstance(info.get(key), str)]
    return {"youtubeId": youtube_id, "title": str(info.get("channel") or info.get("uploader") or info.get("title") or youtube_id)[:500],
            "aliases": aliases, "avatar": channel_avatar(info), "videos": videos}


def main():
    if len(sys.argv) not in (4, 5) or sys.argv[1] not in ("channel", "captions", "metadata"):
        return 2
    action, url, output = sys.argv[1:4]
    proxy = sys.argv[4] if len(sys.argv) == 5 else None
    if proxy is not None:
        if action != "captions" or not re.fullmatch(r"http://127\.0\.0\.1:\d{4,5}", proxy):
            return 2
        if not 1024 <= int(urlsplit(proxy).port) <= 65535:
            return 2
    # Internal callers already validate input, but keep this boundary restrictive as well.
    parsed = urlsplit(url)
    valid = parsed.scheme == "https" and parsed.netloc == "www.youtube.com" and not parsed.fragment
    if action == "channel":
        valid = valid and not parsed.query and bool(re.fullmatch(r"/(?:@[^/]+|channel/UC[A-Za-z0-9_-]{22}|(?:c|user)/[A-Za-z0-9_-]+)/videos", parsed.path))
    else:
        valid = valid and parsed.path == "/watch" and bool(re.fullmatch(r"v=[A-Za-z0-9_-]{11}", parsed.query))
    try:
        if not valid:
            raise SafeFailure("INVALID_RESPONSE")
        try:
            from yt_dlp import YoutubeDL
        except ImportError:
            raise SafeFailure("DEPENDENCY_MISSING") from None
        with YoutubeDL(options(action, proxy)) as downloader:
            info = downloader.extract_info(url, download=False)
            if not isinstance(info, dict):
                raise SafeFailure("INVALID_RESPONSE")
            if action == "channel":
                data = channel_result(info)
            elif action == "metadata":
                if info.get("id") != parse_qs(parsed.query)["v"][0]:
                    raise SafeFailure("INVALID_RESPONSE")
                data = video_metadata(info)
            else:
                data = fetch_captions(info, proxy)
        result = {"ok": True, "data": data}
    except HTTPError as error:
        result = {"ok": False, "code": "RATE_LIMITED" if error.code == 429 else "NETWORK_ERROR", "retryAfter": retry_after_seconds(error.headers) if error.code == 429 else 0}
    except SafeFailure as error:
        result = {"ok": False, "code": str(error)}
    except Exception as error:
        # 仅输出固定错误码；第三方异常可包含签名URL、Cookies与代理凭据。
        result = {"ok": False, "code": "RATE_LIMITED" if re.search(r"(?:HTTP Error|HTTP error|status code)\s*:?\s*429\b", str(error)) else "NETWORK_ERROR"}
    Path(output).write_text(json.dumps(result, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
