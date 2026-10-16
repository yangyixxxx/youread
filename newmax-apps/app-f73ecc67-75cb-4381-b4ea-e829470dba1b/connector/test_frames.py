"""Offline frame contract/security tests; real ffmpeg integration uses synthetic media.
No test contacts YouTube or reads/writes application data or user credentials.
"""
import base64
import http.client
import io
import json
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.request import Request

from connector import frame_worker as f
from connector import server as s
from connector.test_server import FakeBackend

VID = "abcdefghijk"
URL = "https://r1---sn-a.googlevideo.com/videoplayback?expire=123&sig=do-not-log"
# A tiny actual ffmpeg-produced JPEG, not a mocked thumbnail result.
JPEG = base64.b64decode("/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYxLjE5LjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABNAAEBAAAAAAAAAAAAAAAAAAAABwEBAQEAAAAAAAAAAAAAAAAAAAUHEAEAAAAAAAAAAAAAAAAAAAAAEQEAAAAAAAAAAAAAAAAAAAAA/8AAEQgAGAAgAwEiAAIRAAMRAP/aAAwDAQACEQMRAD8AjgDf0sAAAAAB/9k=")


class FakeFrames:
    def __init__(self):
        self.calls = []
        self.source_calls = []
        self.fail = set()
        self.source_error = None
        self.on_capture = None
        self.reason = None
        self.closed = False

    def capability(self):
        return {"capabilities": {"videoFrames": self.reason is None}, **({"frameReason": self.reason} if self.reason else {})}

    def source(self, video_id):
        self.source_calls.append(video_id)
        if self.source_error:
            raise self.source_error
        return {"url": URL, "duration": 120}

    def capture(self, source, seconds):
        self.calls.append(seconds)
        if self.on_capture:
            self.on_capture(seconds)
        if seconds in self.fail:
            raise f.FrameError("NETWORK_ERROR")
        return f.image_result(JPEG)

    def close(self):
        self.closed = True


class FrameFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.frames = FakeFrames()
        self.now = 10000
        self.library = s.Library(self.temp.name, FakeBackend(), clock=lambda: self.now, frame_backend=self.frames)
        self.addCleanup(self.library.close)
        self.library.state["videos"].append({"id": VID, "duration": 120, "transcriptStatus": "none", "transcriptError": None})
        self.library._save()

    def request(self, times):
        return self.library.request_frames(VID, {"times": times})["job"]


class FrameLibraryTests(FrameFixture):
    def test_validation_and_existing_video_only(self):
        invalid = [None, {}, [], "1", True, [True], [None], [-0.1], [float("nan")],
                   [float("inf")], ["2"], [43200.01], [10**500], list(range(6)), [120]]
        for value in invalid:
            with self.subTest(value=str(value)[:30]), self.assertRaises(s.ConnectorError) as caught:
                self.request(value)
            self.assertEqual(caught.exception.status, 400)
        for body in ({}, {"times": [1], "url": URL}, {"times": [1], "cookies": "secret"}, {"times": [1], "command": "whoami"}):
            with self.assertRaises(s.ConnectorError):
                self.library.request_frames(VID, body)
        for identifier in ("video000001", "https://youtube.com/watch?v=" + VID, "bad"):
            with self.assertRaises(s.ConnectorError) as caught:
                self.library.request_frames(identifier, {"times": [1]})
            self.assertEqual(caught.exception.status, 404)
        self.assertEqual(self.frames.source_calls, [])

    def test_twelve_hour_limit_and_unknown_duration(self):
        self.library._video(VID)["duration"] = None
        self.assertEqual(self.request([43200])["items"][0]["seconds"], 43200)

    def test_deduplication_idempotency_busy_and_order(self):
        first = self.request([3, 1.0, 1, 0])
        self.assertEqual([x["seconds"] for x in first["items"]], [0, 1, 3])
        self.assertEqual(first["status"], "queued")
        self.assertEqual(self.request([1, 3, 0])["id"], first["id"])
        with self.assertRaises(s.ConnectorError) as caught:
            self.request([2])
        self.assertEqual(caught.exception.status, 409)
        self.assertEqual(self.library.jobs.qsize(), 1)
        first["items"].clear()
        self.assertEqual(len(self.library.get_frame_job(first["id"])["job"]["items"]), 3)

    def test_concurrent_posts_only_enqueue_one_job(self):
        identifiers = []
        threads = [threading.Thread(target=lambda: identifiers.append(self.request([1, 2])["id"])) for _ in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(set(identifiers)), 1)
        self.assertEqual(self.library.jobs.qsize(), 1)

    def test_running_state_and_idempotent_poll(self):
        job = self.request([1, 2])
        def inspect(seconds):
            running = self.library.get_frame_job(job["id"])["job"]
            self.assertEqual(running["status"], "running")
            self.assertEqual(next(x for x in running["items"] if x["seconds"] == seconds)["status"], "running")
            self.assertEqual(self.request([2, 1])["id"], job["id"])
        self.frames.on_capture = inspect
        self.library.process_next()
        result = self.library.get_frame_job(job["id"])["job"]
        self.assertEqual(result["status"], "done")
        self.assertEqual(self.frames.source_calls, [VID])
        self.assertEqual(self.frames.calls, [1, 2])
        for item in result["items"]:
            self.assertEqual((item["width"], item["height"]), (32, 24))
            self.assertEqual(base64.b64decode(item["dataUrl"].split(",")[1]), JPEG)
        self.assertNotIn("sig", json.dumps(result))
        self.assertNotIn("_times", result)
        self.assertEqual(self.library.jobs.unfinished_tasks, 0)
        self.assertFalse(self.library.scheduled)

    def test_partial_failure_preserves_success_no_retry(self):
        job = self.request([1, 2, 3])
        self.frames.fail = {2}
        self.library.process_next()
        result = self.library.get_frame_job(job["id"])["job"]
        self.assertEqual(result["status"], "error")
        self.assertEqual([x["status"] for x in result["items"]], ["ready", "error", "ready"])
        self.assertEqual(self.frames.calls, [1, 2, 3])
        self.assertNotIn("dataUrl", result["items"][1])
        self.assertIn("已成功", result["error"])
        self.assertEqual(self.library._video(VID)["transcriptStatus"], "none")
        self.assertFalse(self.library.process_next())
        self.assertNotEqual(self.request([1, 2, 3])["id"], job["id"])

    def test_extraction_failure_does_not_change_subtitles_and_next_job_runs(self):
        job = self.request([1, 2])
        self.frames.source_error = RuntimeError("secret URL cookies body")
        self.library.request_transcript(VID)
        self.library.process_next()
        result = self.library.get_frame_job(job["id"])["job"]
        self.assertEqual(result["status"], "error")
        self.assertTrue(all(x["status"] == "error" for x in result["items"]))
        self.assertNotIn("secret", json.dumps(result))
        self.assertEqual(self.library._video(VID)["transcriptStatus"], "pending")
        self.library.process_next()
        self.assertEqual(self.library._video(VID)["transcriptStatus"], "ready")

    def test_non_image_never_becomes_ready(self):
        job = self.request([1])
        with patch.object(self.frames, "capture", return_value={"dataUrl": "data:image/jpeg;base64," + base64.b64encode(b"not image").decode()}):
            self.library.process_next()
        result = self.library.get_frame_job(job["id"])["job"]
        self.assertEqual(result["items"][0]["status"], "error")
        self.assertNotIn("dataUrl", result["items"][0])

    def test_expiry_eviction_and_no_persistence_or_restart_network(self):
        original_bytes = self.library.path.read_bytes()
        identifiers = []
        for _ in range(9):
            identifiers.append(self.request([1])["id"])
            self.library.process_next()
        self.assertEqual(len(self.library.frame_jobs), 8)
        with self.assertRaises(s.ConnectorError) as caught:
            self.library.get_frame_job(identifiers[0])
        self.assertEqual(caught.exception.status, 404)
        self.now += 3600
        with self.assertRaises(s.ConnectorError):
            self.library.get_frame_job(identifiers[-1])
        self.assertFalse(self.library.frame_jobs)
        self.assertEqual(self.library.path.read_bytes(), original_bytes)
        queued = self.request([2])
        restored = s.Library(self.temp.name, FakeBackend(), frame_backend=FakeFrames())
        self.addCleanup(restored.close)
        self.assertTrue(restored.jobs.empty())
        self.assertFalse(restored.frame_jobs)
        with self.assertRaises(s.ConnectorError):
            restored.get_frame_job(queued["id"])

    def test_stop_cancels_queued_and_running_without_restoring(self):
        job = self.request([1, 2])
        self.frames.on_capture = lambda _: self.library.close()
        self.library.process_next()
        result = self.library.get_frame_job(job["id"])["job"]
        self.assertEqual(result["status"], "error")
        self.assertTrue(all(x["status"] == "error" for x in result["items"]))
        self.assertEqual(self.frames.calls, [1])
        self.assertTrue(self.frames.closed)
        with self.assertRaises(s.ConnectorError) as caught:
            self.request([3])
        self.assertEqual(caught.exception.status, 503)

    def test_missing_dependency_is_recoverable_without_queue(self):
        self.frames.reason = f.MESSAGES["FFMPEG_MISSING"]
        self.assertFalse(self.library.frame_capability()["capabilities"]["videoFrames"])
        with self.assertRaises(s.ConnectorError) as caught:
            self.request([1])
        self.assertEqual(caught.exception.status, 503)
        self.assertTrue(caught.exception.retryable)
        self.assertTrue(self.library.jobs.empty())


class FrameHTTPTests(FrameFixture):
    def setUp(self):
        super().setUp()
        self.http = s.ConnectorHTTPServer((s.HOST, 0), self.library, "test-token")
        self.thread = threading.Thread(target=self.http.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop_http)

    def stop_http(self):
        self.http.shutdown()
        self.http.server_close()
        self.thread.join(timeout=2)

    def http_request(self, method, path, body=None, token="test-token", headers=None):
        connection = http.client.HTTPConnection(s.HOST, self.http.server_port, timeout=5)
        request_headers = {"Content-Type": "application/json", **(headers or {})}
        if token is not None:
            request_headers["Authorization"] = "Bearer " + token
        connection.request(method, path, None if body is None else json.dumps(body), request_headers)
        response = connection.getresponse()
        status, raw = response.status, response.read()
        connection.close()
        return status, json.loads(raw) if raw else None

    def test_http_auth_host_origin_body_and_shapes(self):
        for method, path, body in (("POST", f"/videos/{VID}/frames", {"times": [1]}),
                                   ("GET", "/frame-jobs/" + "a" * 32, None)):
            for token in (None, "wrong"):
                self.assertEqual(self.http_request(method, path, body, token=token)[0], 401)
            self.assertEqual(self.http_request(method, path, body, headers={"Origin": "https://evil.com"})[0], 403)
            self.assertEqual(self.http_request(method, path, body, headers={"Host": "evil.com"})[0], 403)
        status, health = self.http_request("GET", "/health")
        self.assertEqual((status, health["capabilities"]), (200, {"videoFrames": True}))
        self.assertNotIn("frameReason", health)
        self.assertEqual(self.http_request("POST", f"/videos/{VID}/frames", {"times": [1], "url": URL})[0], 400)
        self.assertEqual(self.http_request("POST", "/videos/video000001/frames", {"times": [1]})[0], 404)
        status, first = self.http_request("POST", f"/videos/{VID}/frames", {"times": [1]})
        self.assertEqual(status, 202)
        self.assertEqual(set(first), {"ok", "job"})
        self.assertEqual(set(first["job"]), {"id", "videoId", "status", "items"})
        self.assertEqual(first["job"]["items"], [{"seconds": 1, "status": "pending"}])
        self.assertEqual(self.http_request("POST", f"/videos/{VID}/frames", {"times": [1]})[1], first)
        self.assertEqual(self.http_request("POST", f"/videos/{VID}/frames", {"times": [2]})[0], 409)
        self.library.process_next()
        path = "/frame-jobs/" + first["job"]["id"]
        status, result = self.http_request("GET", path)
        self.assertEqual((status, result["job"]["status"]), (200, "done"))
        self.now += 3600
        status, result = self.http_request("GET", path)
        self.assertEqual((status, result["code"]), (404, "FRAME_JOB_NOT_FOUND"))

    def test_http_dependency_reason(self):
        self.frames.reason = f.MESSAGES["DEPENDENCY_MISSING"]
        self.assertIn("yt-dlp", self.http_request("GET", "/health")[1]["frameReason"])
        self.assertEqual(self.http_request("POST", f"/videos/{VID}/frames", {"times": [1]})[0], 503)


class FrameSafetyTests(unittest.TestCase):
    def test_url_allowlist_and_redirects(self):
        for value in (URL, "https://youtube.com/videoplayback?a=b", "https://rr1.googlevideo.com:443/videoplayback"):
            self.assertTrue(f.safe_media_url(value))
        for value in (None, 1, "http://r1.googlevideo.com/videoplayback", "https://evil.com/videoplayback",
                      "https://youtube.com.evil.com/videoplayback", "https://user:pass@googlevideo.com/videoplayback",
                      "https://127.0.0.1/videoplayback", "https://[::1]/videoplayback", "file:///tmp/a",
                      "https://r1.googlevideo.com:444/videoplayback", "https://youtube.com/watch?v=" + VID,
                      "https://r1.googlevideo.com/videoplayback#x", URL + "\n", "https://evil.com\\@googlevideo.com/videoplayback"):
            with self.subTest(value=value):
                self.assertFalse(f.safe_media_url(value))
        with self.assertRaises(f.FrameError):
            f.SafeMediaRedirect().redirect_request(Request(URL), None, 302, "Found", {}, "https://127.0.0.1/private")

    def test_format_selection_excludes_thumbnails_manifests_high_res_and_drm(self):
        valid = {"url": URL, "protocol": "https", "ext": "mp4", "vcodec": "avc1", "acodec": "none", "width": 1280, "height": 720}
        for change in ({"url": "https://i.ytimg.com/vi/x/hqdefault.jpg"}, {"protocol": "m3u8_native"},
                       {"width": 1920}, {"vcodec": "none"}, {"has_drm": True}, {"ext": "jpg"},
                       {"manifest_url": URL}, {"fragments": [{}]}, {"height": None}):
            with self.subTest(change=change), self.assertRaises(f.FrameError):
                f.choose_media({"formats": [{**valid, **change}], "thumbnail": URL})
        result = f.choose_media({"duration": 10, "formats": [{**valid, "height": 360}, valid]})
        self.assertEqual(result, {"url": URL, "duration": 10})
        with self.assertRaises(f.FrameError):
            f.choose_media({"is_live": True, "formats": [valid]})

    def test_extractor_does_not_use_cookies_config_archives_or_retries(self):
        options = f.extractor_options()
        self.assertIsNone(options["cookiefile"])
        self.assertIsNone(options["cookiesfrombrowser"])
        self.assertFalse(options["usenetrc"])
        self.assertTrue(options["skip_download"])
        self.assertFalse(options["cachedir"])
        self.assertEqual(options["retries"], 0)
        self.assertEqual(options["proxy"], "")
        self.assertFalse(options["writethumbnail"])

    def test_jpeg_size_structure_and_valid_result(self):
        self.assertEqual(f.jpeg_dimensions(JPEG), (32, 24))
        for raw in (b"", b"not jpeg", JPEG[:-2], b"\xff\xd8" + b"x" * 30 + b"\xff\xd9", JPEG + b"x" * f.MAX_JPEG_BYTES):
            with self.assertRaises(f.FrameError):
                f.jpeg_dimensions(raw)

    def test_process_output_limit_timeout_and_stop(self):
        backend = f.FrameBackend()
        self.addCleanup(backend.close)
        command = [sys.executable, "-I", "-c", "import sys;sys.stdout.buffer.write(b'x'*50000)"]
        with self.assertRaises(f.FrameError) as caught:
            backend._run(command, 5, 1000)
        self.assertEqual(caught.exception.code, "TOO_LARGE")
        start = time.monotonic()
        with self.assertRaises(f.FrameError) as caught:
            backend._run([sys.executable, "-I", "-c", "import time;time.sleep(20)"], 0.1, 100)
        self.assertEqual(caught.exception.code, "TIMEOUT")
        self.assertLess(time.monotonic() - start, 5)
        errors = []
        def run():
            try:
                backend._run([sys.executable, "-I", "-c", "import time;time.sleep(20)"], 30, 100)
            except f.FrameError as error:
                errors.append(error.code)
        thread = threading.Thread(target=run)
        thread.start()
        deadline = time.monotonic() + 5
        while backend.active is None and time.monotonic() < deadline:
            time.sleep(0.01)
        process = backend.active
        backend.close()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ["STOPPING"])
        self.assertIsNotNone(process.poll())
        self.assertIsNone(backend.active)

    def test_descendant_pipe_is_terminated_with_its_parent_job(self):
        backend = f.FrameBackend()
        self.addCleanup(backend.close)
        code = "import subprocess,sys;subprocess.Popen([sys.executable,'-I','-c','import time;time.sleep(20)']);print('done')"
        start = time.monotonic()
        self.assertEqual(backend._run([sys.executable, "-I", "-c", code], 5, 100).strip(), b"done")
        self.assertLess(time.monotonic() - start, 5)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
    def test_stop_terminates_real_ffmpeg_without_orphan(self):
        backend = f.FrameBackend()
        self.addCleanup(backend.close)
        errors = []
        def run():
            try:
                backend._run([backend.ffmpeg, "-hide_banner", "-loglevel", "quiet", "-nostdin", "-re", "-f", "lavfi",
                              "-i", "color=s=32x24:r=5", "-t", "30", "-f", "null", "-"], 40, 100)
            except f.FrameError as error:
                errors.append(error.code)
        thread = threading.Thread(target=run)
        thread.start()
        deadline = time.monotonic() + 5
        while backend.active is None and time.monotonic() < deadline:
            time.sleep(0.01)
        process = backend.active
        self.assertIsNotNone(process)
        backend.close()
        thread.join(timeout=5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(errors, ["STOPPING"])
        self.assertIsNotNone(process.poll())
        self.assertIsNone(backend.active)

    def test_extracted_duration_and_unsafe_input_fail_before_process(self):
        backend = f.FrameBackend()
        self.addCleanup(backend.close)
        with patch.object(backend, "_run") as run:
            for source, seconds in (({"url": URL, "duration": 2}, 2), ({"url": "file:///x"}, 1),
                                    ({"url": URL}, float("nan")), ({"url": URL}, 43201)):
                with self.assertRaises(f.FrameError):
                    backend.capture(source, seconds)
            run.assert_not_called()

    def test_extractor_error_redacts_untrusted_payload(self):
        backend = f.FrameBackend()
        backend.reason = None
        self.addCleanup(backend.close)
        for payload in (b"secret raw URL", b'{"ok":false,"code":"secret cookies"}',
                        json.dumps({"ok": True, "data": {"url": "https://user:secret@youtube.com/videoplayback"}}).encode()):
            with patch.object(backend, "_run", return_value=payload), self.assertRaises(f.FrameError) as caught:
                backend.source(VID)
            self.assertNotIn("secret", str(caught.exception))

    def test_dependency_detection(self):
        with patch.object(f.shutil, "which", return_value=None):
            backend = f.FrameBackend()
            self.assertFalse(backend.capability()["capabilities"]["videoFrames"])
            self.assertIn("ffmpeg", backend.capability()["frameReason"])
        with patch.object(f.shutil, "which", return_value="ffmpeg"), patch.object(f.importlib.util, "find_spec", return_value=None):
            self.assertIn("yt-dlp", f.FrameBackend().capability()["frameReason"])


class RangeResponse(io.BytesIO):
    def __init__(self, data, request, status=206, final_url=URL):
        match = re.fullmatch(r"bytes=(\d+)-(\d+)", request.get_header("Range"))
        start, end = map(int, match.groups())
        end = min(end, len(data) - 1)
        super().__init__(data[start:end + 1])
        self.status, self.url = status, final_url
        self.headers = {"Content-Range": f"bytes {start}-{end}/{len(data)}"}


class RelayTests(unittest.TestCase):
    def relay_request(self, relay, path=None, headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", relay.server.server_port, timeout=5)
        connection.request("GET", path or relay.path, headers=headers or {})
        response = connection.getresponse()
        status, content = response.status, response.read()
        connection.close()
        return status, content

    def test_relay_range_guard_no_headers_forwarded(self):
        requests = []
        def open_request(request, timeout):
            requests.append(request)
            return RangeResponse(b"abcdefghijkl", request)
        with f.MediaRelay(URL, threading.Event()) as relay, patch.object(f, "build_opener") as opener:
            opener.return_value.open.side_effect = open_request
            self.assertEqual(self.relay_request(relay, headers={"Range": "bytes=3-5"}), (206, b"def"))
            self.assertEqual(self.relay_request(relay, path="/wrong")[0], 403)
            self.assertEqual(self.relay_request(relay, headers={"Range": "bytes=1-2,5-6"})[0], 416)
            self.assertEqual(self.relay_request(relay, headers={"Authorization": "secret"})[0], 403)
            self.assertEqual(len(requests), 1)
            self.assertEqual(set(requests[0].headers), {"Range", "User-agent", "Accept-encoding"})

    def test_relay_rejects_full_body_untrusted_redirect_and_budget(self):
        for status, url, budget in ((200, URL, 100), (206, "https://evil.com/videoplayback", 100), (206, URL, 2)):
            with f.MediaRelay(URL, threading.Event()) as relay, patch.object(f, "build_opener") as opener:
                relay.remaining = budget
                opener.return_value.open.side_effect = lambda request, timeout: RangeResponse(b"abcd", request, status=status, final_url=url)
                self.assertEqual(self.relay_request(relay)[0], 502)
                self.assertIn(relay.error, ("NO_MEDIA", "UNSAFE_MEDIA", "TOO_LARGE"))

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "ffmpeg/ffprobe not installed")
    def test_real_ffmpeg_seeks_synthetic_media_through_guarded_range_stream(self):
        with tempfile.TemporaryDirectory(prefix="frames-synthetic-") as directory:
            path = Path(directory) / "sample.mp4"
            subprocess.run([shutil.which("ffmpeg"), "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                            "testsrc2=s=1920x1080:r=5:d=2", "-an", "-c:v", "mpeg4", "-q:v", "10", str(path)],
                           stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=20)
            media = path.read_bytes()
            backend = f.FrameBackend()
            requests = []
            def open_request(request, timeout):
                requests.append(request.get_header("Range"))
                return RangeResponse(media, request)
            with patch.object(f, "build_opener") as opener:
                opener.return_value.open.side_effect = open_request
                result = backend.capture({"url": URL, "duration": 2}, 0.8)
            self.assertEqual((result["width"], result["height"]), (1280, 720))
            raw = base64.b64decode(result["dataUrl"].split(",", 1)[1])
            probe = subprocess.run([shutil.which("ffprobe"), "-v", "error", "-show_entries", "stream=codec_name,width,height",
                                    "-of", "json", "-i", "pipe:0"], input=raw, capture_output=True, timeout=10, check=True)
            stream = json.loads(probe.stdout)["streams"][0]
            self.assertEqual((stream["codec_name"], stream["width"], stream["height"]), ("mjpeg", 1280, 720))
            self.assertTrue(requests)
            self.assertIsNone(backend.active)
            self.assertEqual([item.name for item in Path(directory).iterdir()], ["sample.mp4"])
            backend.close()


if __name__ == "__main__":
    unittest.main()
