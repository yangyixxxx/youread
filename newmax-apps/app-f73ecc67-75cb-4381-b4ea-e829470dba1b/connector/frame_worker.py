"""On-demand video frames. No cookies, media archives, user config, or raw logs.

The extractor is isolated; ffmpeg is owned directly by the connector (never by
an extractor child). Signed media URLs live only in bounded pipes/memory.
"""
from __future__ import annotations

import base64
import importlib.util
import json
import math
import os
import re
import shutil
import secrets
import signal
import struct
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, ProxyHandler, Request, build_opener

MAX_JPEG_BYTES = 1024 * 1024
MAX_METADATA_BYTES = 64 * 1024
MAX_SECONDS = 12 * 60 * 60
EXTRACT_TIMEOUT = 75
FRAME_TIMEOUT = 40
MESSAGES = {
    "DEPENDENCY_MISSING": "缺少 yt-dlp 依赖，请安装连接器依赖并重新启动后重试。",
    "FFMPEG_MISSING": "未找到 ffmpeg，请安装并加入 PATH，重新启动连接器后重试。",
    "NETWORK_ERROR": "无法读取 YouTube 视频媒体，可能网络或访问受限；请检查网络后手动重试，不会使用封面代替截图。",
    "NO_MEDIA": "此视频暂无可用的有限分辨率 HTTPS 直连媒体，可能访问受限；可稍后重试或选择本地图片。",
    "UNSAFE_MEDIA": "视频媒体地址不符合安全限制，已停止取帧；请稍后重试或选择本地图片。",
    "TIMEOUT": "视频取帧超时，已停止本次进程；请检查网络后手动重试。",
    "TOO_LARGE": "截图或媒体信息超过安全大小限制；请换一个时间点或选择本地图片。",
    "INVALID_IMAGE": "未获得有效的视频 JPEG 画面；请换一个时间点重试，不会使用封面代替截图。",
    "INVALID_RESPONSE": "视频媒体信息无效，请稍后重试或选择本地图片。",
    "OUT_OF_RANGE": "所选时间已超出视频时长，请选择更早的时间点。",
    "STOPPING": "连接器正在停止，截图任务已取消；重新启动后请手动获取。",
    "PROCESS_ERROR": "视频取帧进程无法运行，请检查连接器依赖后重试。",
}


class FrameError(Exception):
    def __init__(self, code):
        self.code = code if code in MESSAGES else "PROCESS_ERROR"
        self.message = MESSAGES[self.code]
        super().__init__(self.message)


def number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def safe_media_url(value):
    if not isinstance(value, str) or not 1 <= len(value) <= 32768 or re.search(r"[\x00-\x20\x7f\\]", value):
        return False
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ""
        return (parsed.scheme == "https" and parsed.username is None and parsed.password is None
                and parsed.port in (None, 443) and not parsed.fragment
                and re.fullmatch(r"[a-z0-9.-]+", host) is not None
                and any(host == root or host.endswith("." + root) for root in ("googlevideo.com", "youtube.com"))
                and parsed.path == "/videoplayback")
    except (TypeError, ValueError):
        return False


class SafeMediaRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        if not safe_media_url(newurl):
            raise FrameError("UNSAFE_MEDIA")
        return super().redirect_request(request, fp, code, message, headers, newurl)


class MediaRelay:
    """Stream seekable HTTPS byte ranges, validating every redirect.

    ffmpeg's own HTTP implementation cannot enforce a hostname allowlist after
    redirects. This per-frame loopback relay does so without storing any media.
    Every request requires its random path; no arbitrary target/headers accepted.
    """
    RANGE_BYTES = 8 * 1024 * 1024
    TOTAL_BYTES = 32 * 1024 * 1024
    MAX_REQUESTS = 16

    def __init__(self, url, stop_event):
        if not safe_media_url(url):
            raise FrameError("UNSAFE_MEDIA")
        self.url, self.stop_event = url, stop_event
        self.closed = threading.Event()
        self.path = "/" + secrets.token_urlsafe(24)
        self.lock = threading.Lock()
        self.remaining, self.requests = self.TOTAL_BYTES, 0
        self.slots = threading.BoundedSemaphore(2)
        self.error = None
        relay = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_GET(self):
                relay._serve(self)

            do_HEAD = do_GET

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            block_on_close = False
            request_queue_size = 2

            def handle_error(self, *args):
                pass

            def get_request(self):
                connection, address = super().get_request()
                connection.settimeout(3)
                return connection, address

        self.server = Server(("127.0.0.1", 0), Handler)
        self.local_url = f"http://127.0.0.1:{self.server.server_port}{self.path}"
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05},
                                       name="frame-range-relay", daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.closed.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=1)
        self.url = ""  # Drop the signed address immediately after this capture.

    def _serve(self, handler):
        acquired, headers_sent = False, False
        try:
            if (handler.path != self.path or handler.headers.get("Host") != f"127.0.0.1:{self.server.server_port}"
                    or handler.headers.get("Authorization") or handler.headers.get("Cookie")
                    or self.closed.is_set() or self.stop_event.is_set()):
                handler.send_error(403)
                return
            acquired = self.slots.acquire(blocking=False)
            if not acquired:
                handler.send_error(503)
                return
            ranges = handler.headers.get_all("Range", [])
            value = ranges[0] if len(ranges) == 1 else "bytes=0-" if not ranges else ""
            match = re.fullmatch(r"bytes=(\d{1,18})-(\d{1,18})?", value)
            if not match:
                handler.send_error(416)
                return
            start = int(match[1])
            end = min(start + self.RANGE_BYTES - 1, int(match[2]) if match[2] else start + self.RANGE_BYTES - 1)
            if end < start:
                handler.send_error(416)
                return
            with self.lock:
                self.requests += 1
                if self.requests > self.MAX_REQUESTS or self.remaining <= 0:
                    raise FrameError("TOO_LARGE")
            # Never forward yt-dlp/external cookies, authorization, proxies, or headers.
            request = Request(self.url, headers={"Range": f"bytes={start}-{end}",
                              "User-Agent": "Mozilla/5.0", "Accept-Encoding": "identity"}, method=handler.command)
            with build_opener(ProxyHandler({}), SafeMediaRedirect()).open(request, timeout=8) as response:
                if not safe_media_url(response.url):
                    raise FrameError("UNSAFE_MEDIA")
                content_range = response.headers.get("Content-Range", "")
                span = re.fullmatch(r"bytes (\d{1,18})-(\d{1,18})/(\d{1,18})", content_range)
                if response.status != 206 or not span:
                    raise FrameError("NO_MEDIA")  # Never silently download a non-seekable whole response.
                begin, finish, total = map(int, span.groups())
                if begin != start or not begin <= finish <= end or finish >= total:
                    raise FrameError("INVALID_RESPONSE")
                length = finish - begin + 1
                if response.headers.get("Content-Encoding", "identity") != "identity":
                    raise FrameError("INVALID_RESPONSE")
                with self.lock:
                    if length > self.remaining:
                        raise FrameError("TOO_LARGE")
                handler.send_response(206)
                handler.send_header("Content-Type", "application/octet-stream")
                handler.send_header("Content-Length", str(length))
                handler.send_header("Content-Range", content_range)
                handler.send_header("Accept-Ranges", "bytes")
                handler.send_header("Connection", "close")
                handler.end_headers()
                headers_sent = True
                while handler.command == "GET" and length > 0 and not self.closed.is_set() and not self.stop_event.is_set():
                    with self.lock:
                        amount = min(64 * 1024, length, self.remaining)
                        if amount <= 0:
                            raise FrameError("TOO_LARGE")
                        self.remaining -= amount
                    chunk = response.read(amount)
                    with self.lock:
                        self.remaining += amount - len(chunk)
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
                    length -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # ffmpeg closes ranges as soon as it has enough bytes or seeks elsewhere.
        except Exception as error:
            self.error = error.code if isinstance(error, FrameError) else "NETWORK_ERROR"
            if not headers_sent:
                try:
                    handler.send_error(502)
                except OSError:
                    pass
        finally:
            handler.close_connection = True
            if acquired:
                self.slots.release()


class QuietLogger:
    def debug(self, *args, **kwargs):
        pass
    info = warning = error = debug


def extractor_options():
    return {
        "quiet": True, "no_warnings": True, "logger": QuietLogger(), "noprogress": True,
        "skip_download": True, "cachedir": False, "socket_timeout": 12,
        "retries": 0, "extractor_retries": 0, "fragment_retries": 0,
        "ignoreerrors": False, "noplaylist": True,
        "cookiefile": None, "cookiesfrombrowser": None, "usenetrc": False, "proxy": "",
        "writeinfojson": False, "writethumbnail": False, "writesubtitles": False,
        "writeautomaticsub": False, "ignore_no_formats_error": True,
        "js_runtimes": {"node": {}}, "remote_components": set(),
        "extractor_args": {"youtube": {"skip": ["hls", "dash", "translated_subs"]}},
    }


def choose_media(info):
    if not isinstance(info, dict) or info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise FrameError("NO_MEDIA")
    candidates = []
    for fmt in info.get("formats") or []:
        if not isinstance(fmt, dict):
            continue
        width, height = fmt.get("width"), fmt.get("height")
        if (fmt.get("protocol") != "https" or fmt.get("ext") not in ("mp4", "webm")
                or not fmt.get("vcodec") or fmt["vcodec"] == "none" or fmt.get("has_drm")
                or fmt.get("fragments") or fmt.get("manifest_url")
                or not number(width) or not number(height) or not 1 <= width <= 1280 or not 1 <= height <= 2160
                or not safe_media_url(fmt.get("url"))):
            continue
        # Prefer roughly 720p, then progressive MP4/video-only MP4 over WebM.
        rank = (min(width * height, 1280 * 720), fmt["ext"] == "mp4", fmt.get("acodec") == "none")
        candidates.append((rank, fmt))
    if not candidates:
        raise FrameError("NO_MEDIA")
    fmt = max(candidates, key=lambda candidate: candidate[0])[1]
    duration = info.get("duration")
    return {"url": fmt["url"], "duration": duration if number(duration) and duration >= 0 else None}


def jpeg_dimensions(data):
    """Read a bounded JPEG SOF, and reject truncated/non-image output."""
    if not isinstance(data, bytes) or not 20 <= len(data) <= MAX_JPEG_BYTES or data[:2] != b"\xff\xd8" or data[-2:] != b"\xff\xd9":
        raise FrameError("INVALID_IMAGE")
    pos, dimensions = 2, None
    while pos < len(data) - 2:
        if data[pos] != 255:
            raise FrameError("INVALID_IMAGE")
        while pos < len(data) and data[pos] == 255:
            pos += 1
        if pos >= len(data):
            break
        marker = data[pos]
        pos += 1
        if marker in (0, 0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            raise FrameError("INVALID_IMAGE")
        if pos + 2 > len(data):
            break
        length = int.from_bytes(data[pos:pos + 2], "big")
        if length < 2 or pos + length > len(data) - 2:
            break
        if marker in (0xC0, 0xC1, 0xC2):
            if length < 11 or data[pos + 2] != 8:
                break
            height, width = struct.unpack(">HH", data[pos + 3:pos + 7])
            if not 1 <= width <= 1280 or not 1 <= height <= 4096:
                break
            dimensions = width, height
        if marker == 0xDA:
            if dimensions and pos + length < len(data) - 2:
                return dimensions
            break
        pos += length
    raise FrameError("INVALID_IMAGE")


def image_result(raw):
    width, height = jpeg_dimensions(raw)
    return {"dataUrl": "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii"),
            "width": width, "height": height}


class _WindowsJob:
    """Kill extractor JS descendants as well when closing a Windows process job."""
    def __init__(self):
        self.handle = None
        if os.name != "nt":
            return
        import ctypes
        from ctypes import wintypes as w
        class Basic(ctypes.Structure):
            _fields_ = [("processTime", ctypes.c_int64), ("jobTime", ctypes.c_int64),
                        ("flags", w.DWORD), ("minWS", ctypes.c_size_t), ("maxWS", ctypes.c_size_t),
                        ("active", w.DWORD), ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class IO(ctypes.Structure):
            _fields_ = [(name, ctypes.c_uint64) for name in ("read", "write", "other", "readBytes", "writeBytes", "otherBytes")]
        class Extended(ctypes.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("processMemory", ctypes.c_size_t),
                        ("jobMemory", ctypes.c_size_t), ("peakProcess", ctypes.c_size_t), ("peakJob", ctypes.c_size_t)]
        self.api = ctypes.WinDLL("kernel32", use_last_error=True)
        self.api.CreateJobObjectW.argtypes = [ctypes.c_void_p, w.LPCWSTR]
        self.api.CreateJobObjectW.restype = w.HANDLE
        self.api.SetInformationJobObject.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.api.CloseHandle.argtypes = [w.HANDLE]
        handle = self.api.CreateJobObjectW(None, None)
        if not handle:
            raise OSError("job creation failed")
        self.handle = handle
        limits = Extended()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not self.api.SetInformationJobObject(handle, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            self.close()
            raise OSError("job configuration failed")

    def assign(self, process):
        if self.handle and not self.api.AssignProcessToJobObject(self.handle, int(process._handle)):
            raise OSError("job assignment failed")

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


class FrameBackend:
    def __init__(self):
        self.python = sys.executable
        self.ffmpeg = shutil.which("ffmpeg")
        self.lock = threading.RLock()
        self.active = None
        self.stopping = threading.Event()
        self.reason = (MESSAGES["FFMPEG_MISSING"] if not self.ffmpeg else
                       MESSAGES["DEPENDENCY_MISSING"] if importlib.util.find_spec("yt_dlp") is None else None)

    def capability(self):
        return {"capabilities": {"videoFrames": self.reason is None}, **({"frameReason": self.reason} if self.reason else {})}

    @staticmethod
    def _kill(process):
        try:
            if os.name != "nt":
                os.killpg(process.pid, signal.SIGKILL)
            elif process.poll() is None:
                process.kill()
        except (OSError, ProcessLookupError):
            pass

    def close(self):
        self.stopping.set()
        with self.lock:
            if self.active:
                self._kill(self.active)

    def _run(self, command, timeout, limit, extractor=False):
        """Bound stdout while running, not after communicate() allocates it all."""
        process, job, reader = None, None, None
        output, overflow = bytearray(), threading.Event()
        try:
            job = _WindowsJob()
            with self.lock:
                if self.stopping.is_set():
                    raise FrameError("STOPPING")
                process = subprocess.Popen(command, shell=False,
                                           stdin=subprocess.PIPE if extractor else subprocess.DEVNULL,
                                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                           start_new_session=os.name != "nt")
                self.active = process
                job.assign(process)
                # The extractor cannot import yt-dlp/spawn JS until contained.
                if extractor:
                    process.stdin.write(b"go\n")
                    process.stdin.close()
            def consume():
                try:
                    while True:
                        chunk = process.stdout.read(min(16384, limit + 1 - len(output)))
                        if not chunk:
                            break
                        output.extend(chunk)
                        if len(output) > limit:
                            overflow.set()
                            break
                except (OSError, ValueError):
                    pass
            reader = threading.Thread(target=consume, name="frame-bounded-output", daemon=True)
            reader.start()
            deadline = time.monotonic() + timeout
            while process.poll() is None:
                if self.stopping.wait(0.025):
                    raise FrameError("STOPPING")
                if overflow.is_set():
                    raise FrameError("TOO_LARGE")
                if time.monotonic() >= deadline:
                    raise FrameError("TIMEOUT")
            # Closing the job kills any residual JS children holding a pipe open.
            job.close()
            if os.name != "nt":
                self._kill(process)
            reader.join(timeout=2)
            if self.stopping.is_set():
                raise FrameError("STOPPING")
            if reader.is_alive():
                raise FrameError("PROCESS_ERROR")
            if overflow.is_set():
                raise FrameError("TOO_LARGE")
            if process.returncode != 0 and not extractor:
                raise FrameError("NETWORK_ERROR")
            return bytes(output)
        except OSError:
            raise FrameError("PROCESS_ERROR") from None
        finally:
            if process:
                self._kill(process)
            if job:
                job.close()
            if process:
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    pass
                if reader:
                    reader.join(timeout=2)
                if process.stdout and (not reader or not reader.is_alive()):
                    process.stdout.close()
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()
            with self.lock:
                self.active = None

    def source(self, video_id):
        if not isinstance(video_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
            raise FrameError("INVALID_RESPONSE")
        if self.reason:
            raise FrameError("FFMPEG_MISSING" if not self.ffmpeg else "DEPENDENCY_MISSING")
        raw = self._run([self.python, "-I", str(Path(__file__).resolve()), "extract", video_id],
                        EXTRACT_TIMEOUT, MAX_METADATA_BYTES, extractor=True)
        try:
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise ValueError()
            if result.get("ok") is not True:
                raise FrameError(result.get("code", "NETWORK_ERROR"))
            source = result["data"]
            if not isinstance(source, dict) or not safe_media_url(source.get("url")):
                raise FrameError("UNSAFE_MEDIA")
            return source
        except (ValueError, TypeError, KeyError):
            raise FrameError("INVALID_RESPONSE") from None

    def capture(self, source, seconds):
        if not safe_media_url(source.get("url")):
            raise FrameError("UNSAFE_MEDIA")
        if not number(seconds) or not 0 <= seconds <= MAX_SECONDS:
            raise FrameError("OUT_OF_RANGE")
        duration = source.get("duration")
        if number(duration) and duration >= 0 and seconds >= duration:
            raise FrameError("OUT_OF_RANGE")
        # Input seek, one decoded frame. The relay enforces remote-domain/redirect
        # and transfer limits while streaming byte ranges; no media file is saved.
        with MediaRelay(source["url"], self.stopping) as relay:
            command = [self.ffmpeg, "-hide_banner", "-loglevel", "quiet", "-nostdin",
                       "-rw_timeout", "12000000", "-protocol_whitelist", "http,tcp",
                       "-http_proxy", "", "-reconnect", "0", "-seekable", "1",
                       "-ss", format(seconds, ".6f"), "-format_whitelist", "mov,matroska,webm",
                       "-i", relay.local_url, "-map", "0:v:0", "-an", "-sn", "-dn",
                       "-frames:v", "1", "-vf", "scale=w='min(1280,iw)':h=-2",
                       "-threads", "1", "-c:v", "mjpeg", "-q:v", "3", "-f", "image2pipe", "pipe:1"]
            try:
                raw = self._run(command, FRAME_TIMEOUT, MAX_JPEG_BYTES)
            except FrameError as error:
                if relay.error and error.code == "NETWORK_ERROR":
                    raise FrameError(relay.error) from None
                raise
            return image_result(raw)


def main():
    # No arbitrary URL, command, output path or extraction options accepted.
    if len(sys.argv) != 3 or sys.argv[1] != "extract" or not re.fullmatch(r"[A-Za-z0-9_-]{11}", sys.argv[2]):
        return 2
    if sys.stdin.buffer.readline(4) != b"go\n":
        return 2
    try:
        try:
            from yt_dlp import YoutubeDL
        except ImportError:
            raise FrameError("DEPENDENCY_MISSING") from None
        with YoutubeDL(extractor_options()) as downloader:
            info = downloader.extract_info("https://www.youtube.com/watch?v=" + sys.argv[2], download=False)
            data = choose_media(info)
        result = {"ok": True, "data": data}
    except FrameError as error:
        result = {"ok": False, "code": error.code}
    except Exception:
        result = {"ok": False, "code": "NETWORK_ERROR"}
    # Only the parent reads this bounded pipe; no URL/header/exception is logged.
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=True, allow_nan=False).encode("ascii"))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
