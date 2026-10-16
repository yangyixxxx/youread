"""Isolated standard-library tests. Fake backend tests never contact YouTube."""
import copy
import http.client
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from connector import server as s
from connector import yt_worker as yt

CID = "UC" + "A" * 22
OTHER_CID = "UC" + "B" * 22
VID = "abcdefghijk"


def entry(index=0):
    return {"id": f"video{index:06d}", "title": f"真实格式测试 {index}", "publishedAt": None,
            "duration": 120, "thumbnail": None}


def channel_result(count=5, cid=CID):
    return {"youtubeId": cid, "title": "测试频道", "videos": [entry(i) for i in range(count)],
            "aliases": ["https://www.youtube.com/@Example"]}


def caption_result():
    return {"raw": json.dumps({"events": [{"tStartMs": 0, "dDurationMs": 1200, "segs": [{"utf8": "测试字幕"}]}]}),
            "format": "json3", "language": "zh-Hans", "source": "automatic"}


class FakeBackend:
    def __init__(self):
        self.result = channel_result()
        self.channel_calls, self.caption_calls = [], []
        self.channel_error = self.caption_error = None
        self.callback = None

    def channel(self, url):
        self.channel_calls.append(url)
        if self.callback:
            self.callback()
        if self.channel_error:
            raise self.channel_error
        return copy.deepcopy(self.result)

    def captions(self, identifier):
        self.caption_calls.append(identifier)
        if self.caption_error:
            raise self.caption_error
        return caption_result()


class InputTests(unittest.TestCase):
    def test_handle_normalization(self):
        self.assertEqual(s.normalize_channel(" @Example "), ("https://www.youtube.com/@Example", "/@example"))
        self.assertEqual(s.normalize_channel("https://m.youtube.com/@EXAMPLE/videos/")[1], "/@example")

    def test_canonical_id_preserves_case(self):
        self.assertEqual(s.normalize_channel(CID)[1], "/channel/" + CID)
        self.assertNotEqual(s.normalize_channel(CID)[1], s.normalize_channel("UC" + "a" * 22)[1])

    def test_chinese_and_legacy_channels(self):
        self.assertEqual(s.normalize_channel("https://www.youtube.com/@%E4%B8%AD%E6%96%87")[1], "/@中文")
        self.assertEqual(s.normalize_channel("https://youtube.com/user/Example/featured")[1], "/user/example")
        self.assertEqual(s.normalize_channel("https://youtube.com/c/Example")[1], "/c/example")

    def test_rejects_untrusted_urls_and_shell_inputs(self):
        bad = [None, 123, {}, "", "https://youtu.be/abcdefghijk", "https://evil.com/@Example",
               "https://youtube.com.evil.com/@Example", "https://www.youtube.com@evil.com/@Example",
               "https://evil.com@youtube.com/@Example", "https://youtube.com:443/@Example",
               "https://youtube.com/watch?v=abcdefghijk", "https://youtube.com/playlist?list=1",
               "file:///etc/passwd", "http://127.0.0.1/@Example", "@Example;whoami", "@a\nb",
               "https://youtube.com/@Example?x=1", "https://youtube.com/@Example#x",
               "https://youtube.com/@foo%2fbar", "https://youtube.com/@%252fetc",
               "https://youtube.com\\@Example", "UC123", "@-bad", "@a" * 40]
        for value in bad:
            with self.subTest(value=value), self.assertRaises(s.ConnectorError):
                s.normalize_channel(value)

    def test_origin_boundaries(self):
        for origin in ("null", "http://localhost:5173", "https://127.0.0.1:443", "http://[::1]:1234"):
            self.assertTrue(s.allowed_origin(origin), origin)
        for origin in ("https://evil.com", "http://localhost.evil.com", "file://", "http://user@localhost",
                       "http://localhost/path", "http://localhost:bad", "http://localhost?x=1"):
            self.assertFalse(s.allowed_origin(origin), origin)


class CaptionTests(unittest.TestCase):
    def test_json3_rolling_overlap(self):
        raw = json.dumps({"events": [
            {"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "hello world"}]},
            {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "hello world again"}]},
            {"tStartMs": 2000, "dDurationMs": 2000, "segs": [{"utf8": "world again today"}]},
        ]})
        segments = s.parse_captions(raw, "json3")
        self.assertEqual([item["text"] for item in segments], ["hello world", "again", "today"])
        self.assertEqual(segments[1]["start"], 1)

    def test_json3_chinese_overlap(self):
        raw = json.dumps({"events": [
            {"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "今天学习"}]},
            {"tStartMs": 1000, "dDurationMs": 2000, "segs": [{"utf8": "学习人工智能"}]},
        ]})
        self.assertEqual([seg["text"] for seg in s.parse_captions(raw, "json3")], ["今天学习", "人工智能"])

    def test_vtt_markup_settings_and_overlap(self):
        raw = "﻿WEBVTT\r\n\r\nNOTE ignored\r\nhello\r\n\r\n1\r\n00:00.000 --> 00:02.000 align:start\r\n<c>Hello &amp; world</c>\r\n\r\n00:01.000 --> 00:03.000\r\n<00:01.000>Hello &amp; world again\r\n"
        result = s.parse_captions(raw, "vtt")
        self.assertEqual([item["text"] for item in result], ["Hello & world", "again"])
        self.assertEqual(result[-1]["end"], 3)

    def test_duplicate_cues_extend_end(self):
        result = s.parse_captions("WEBVTT\n\n00:00.000 --> 00:02.000\nsame\n\n00:01.000 --> 00:03.000\nsame\n", "vtt")
        self.assertEqual(result, [{"start": 0, "end": 3, "text": "same"}])

    def test_distant_repetition_is_not_removed(self):
        raw = "WEBVTT\n\n00:00.000 --> 00:01.000\nthank you\n\n00:05.000 --> 00:06.000\nthank you\n"
        self.assertEqual(len(s.parse_captions(raw, "vtt")), 2)

    def test_invalid_empty_and_size_limits(self):
        for raw, fmt in (("not json", "json3"), ("[]", "json3"), ("{}", "json3"), ("WEBVTT", "vtt"), ("text", "txt")):
            with self.subTest(raw=raw), self.assertRaises(s.ConnectorError):
                s.parse_captions(raw, fmt)
        with patch.object(s, "MAX_CAPTION_BYTES", 2), self.assertRaises(s.ConnectorError):
            s.parse_captions("four", "vtt")

    def test_track_priority_and_translation_exclusion(self):
        def track(ext="json3", query="lang=en"):
            return {"ext": ext, "url": "https://www.youtube.com/api/timedtext?" + query}
        info = {"subtitles": {"en": [track("vtt")]}, "automatic_captions": {
            "zh-Hans": [track(query="lang=en&tlang=zh-Hans")], "en": [track()]}}
        language, source, chosen = yt.choose_track(info)
        self.assertEqual((language, source, chosen["ext"]), ("en", "manual", "vtt"))
        info["subtitles"]["zh-Hans"] = [track(query="lang=zh-Hans")]
        self.assertEqual(yt.choose_track(info)[:2], ("zh-Hans", "manual"))

    def test_caption_url_guard(self):
        self.assertTrue(yt.safe_caption_url("https://www.youtube.com/api/timedtext?v=x"))
        self.assertTrue(yt.safe_caption_url("https://r1.googlevideo.com/a"))
        for url in ("http://www.youtube.com/a", "https://youtube.com.evil.com/a", "https://127.0.0.1/a", "https://user@youtube.com/a", "https://youtube.com:444/a"):
            self.assertFalse(yt.safe_caption_url(url))
        with self.assertRaises(yt.SafeFailure):
            yt.choose_track({"automatic_captions": {"live_chat": [{"ext": "json3", "url": "https://youtube.com/a"}]}})

    def test_flat_mapping_no_invented_dates_and_dedup(self):
        result = yt.channel_result({"channel_id": CID, "channel": "Example", "entries": [
            {"id": VID, "title": "A", "duration": 120}, {"id": VID}, {"id": "bad"}]})
        self.assertEqual(len(result["videos"]), 1)
        self.assertIsNone(result["videos"][0]["publishedAt"])

    def test_flat_twenty_and_network_options(self):
        result = yt.channel_result({"channel_id": CID, "entries": [entry(i) for i in range(40)]})
        self.assertEqual(len(result["videos"]), 20)
        opts = yt.options("channel")
        self.assertEqual(opts["extract_flat"], "in_playlist")
        self.assertEqual(opts["playlist_items"], "1:20")
        self.assertEqual(opts["socket_timeout"], 12)
        self.assertFalse(opts["writesubtitles"])
        self.assertIsNone(opts["cookiesfrombrowser"])


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backend = FakeBackend()
        self.now = 100000
        self.library = s.Library(self.temp.name, self.backend, clock=lambda: self.now)
        self.addCleanup(self.library.close)

    def add(self, value="@Example"):
        return self.library.add_channel(value)["channel"]["id"]

    def drain(self, maximum=30):
        for _ in range(maximum):
            if not self.library.process_next():
                return
        self.fail("queue did not drain")

    def test_add_is_async_and_handle_dedup(self):
        identifier = self.add()
        duplicate = self.library.add_channel("https://youtube.com/@EXAMPLE/videos")
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["channel"]["id"], identifier)
        self.assertEqual(self.backend.channel_calls, [])
        self.assertEqual(self.library.jobs.qsize(), 1)

    def test_first_sync_twenty_and_only_three_captions(self):
        self.backend.result = channel_result(30)
        self.add()
        self.drain()
        snapshot = self.library.snapshot()
        self.assertEqual(len(snapshot["videos"]), 20)
        self.assertEqual(len(self.backend.caption_calls), 3)
        self.assertEqual(snapshot["channels"][0]["status"], "ready")
        self.assertNotIn("_aliases", snapshot["channels"][0])
        self.assertEqual(sum(v["transcriptStatus"] == "ready" for v in snapshot["videos"]), 3)

    def test_resync_dedup_and_three_new_caption_limit(self):
        identifier = self.add()
        self.drain()
        self.library.sync(identifier)
        self.drain()
        self.assertEqual(len(self.library.snapshot()["videos"]), 5)
        self.assertEqual(len(self.backend.caption_calls), 3)
        self.backend.result["videos"] = [entry(i) for i in range(10, 15)] + [entry(i) for i in range(5)]
        self.library.sync(identifier)
        self.drain()
        self.assertEqual(len(self.backend.caption_calls), 6)
        self.assertEqual(len(self.library.snapshot()["videos"]), 10)

    def test_canonical_alias_merge(self):
        first = self.add("@One")
        second = self.add("@Two")
        self.drain()
        snapshot = self.library.snapshot()
        self.assertEqual(len(snapshot["channels"]), 1)
        self.assertEqual(snapshot["channels"][0]["id"], first)
        self.assertTrue(all(v["channelId"] == first for v in snapshot["videos"]))
        self.assertTrue(self.library.add_channel(CID)["duplicate"])
        self.assertTrue(self.library.add_channel("@Two")["duplicate"])
        self.assertNotEqual(first, second)

    def test_remove_preserves_videos_and_transcripts(self):
        identifier = self.add()
        self.drain()
        transcript = self.library.get_transcript(entry()["id"])
        self.library.remove_channel(identifier)
        self.assertEqual(len(self.library.snapshot()["channels"]), 0)
        self.assertEqual(len(self.library.snapshot()["videos"]), 5)
        self.assertEqual(self.library.get_transcript(entry()["id"]), transcript)

    def test_cancel_queued_and_in_flight(self):
        identifier = self.add()
        self.library.remove_channel(identifier)
        self.drain()
        self.assertFalse(self.backend.channel_calls)
        identifier = self.add()
        self.backend.callback = lambda: self.library.remove_channel(identifier)
        self.drain()
        self.assertEqual(self.library.snapshot()["channels"], [])
        self.assertEqual(self.library.snapshot()["videos"], [])

    def test_resubscribe_relinks_retained_videos(self):
        old_id = self.add()
        self.drain()
        self.library.remove_channel(old_id)
        self.backend.result = channel_result(1)
        new_id = self.add()
        self.drain()
        self.assertNotEqual(old_id, new_id)
        self.assertTrue(all(v["channelId"] == new_id for v in self.library.snapshot()["videos"]))

    def test_pending_queue_recovery(self):
        self.add()
        restored = s.Library(self.temp.name, self.backend, clock=lambda: self.now)
        self.addCleanup(restored.close)
        self.assertEqual(restored.jobs.qsize(), 1)
        restored.process_next()
        recovered = s.Library(self.temp.name, self.backend, clock=lambda: self.now)
        self.addCleanup(recovered.close)
        self.assertEqual(recovered.jobs.qsize(), 3)
        recovered.process_next()
        self.assertEqual(recovered.snapshot()["videos"][0]["transcriptStatus"], "ready")

    def test_in_progress_recovered_as_pending(self):
        identifier = self.add()
        with self.library.lock:
            self.library._channel(identifier)["status"] = "syncing"
            self.library._save()
        restored = s.Library(self.temp.name, self.backend, clock=lambda: self.now)
        self.addCleanup(restored.close)
        self.assertEqual(restored.snapshot()["channels"][0]["status"], "pending")
        self.assertEqual(restored.jobs.qsize(), 1)

    def test_thirty_minute_scheduler_and_no_duplicate_queue(self):
        self.add()
        self.drain()
        self.assertEqual(self.library.snapshot()["settings"]["intervalMinutes"], 30)
        self.now += 1799
        self.assertEqual(self.library.schedule_due(), 0)
        self.now += 1
        self.assertEqual(self.library.schedule_due(), 1)
        self.assertEqual(self.library.schedule_due(), 0)
        self.assertEqual(self.library.sync()["queued"], 0)

    def test_error_does_not_spin_and_manual_retry_recovers(self):
        identifier = self.add()
        self.backend.channel_error = s.ConnectorError("NETWORK_TIMEOUT", "连接超时，请重试。", 502)
        self.drain()
        self.assertEqual(self.library.snapshot()["channels"][0]["status"], "error")
        self.assertEqual(self.library.schedule_due(), 0)
        self.backend.channel_error = None
        self.library.sync(identifier)
        self.drain()
        self.assertEqual(self.library.snapshot()["channels"][0]["status"], "ready")

    def test_unexpected_exception_does_not_poison_queue_or_leak_secrets(self):
        self.add("@First")
        self.add("@Second")
        self.backend.channel_error = RuntimeError("secret token password cookies")
        self.library.process_next()
        self.backend.channel_error = None
        self.library.process_next()
        snapshot = self.library.snapshot()
        self.assertEqual(snapshot["channels"][0]["status"], "error")
        self.assertEqual(snapshot["channels"][1]["status"], "ready")
        self.assertNotIn("secret", json.dumps(snapshot))
        self.drain()
        self.assertEqual(self.library.jobs.unfinished_tasks, 0)
        self.assertEqual(self.library.scheduled, set())

    def test_unavailable_caption_retries(self):
        self.backend.caption_error = s.ConnectorError("NO_CAPTIONS", "暂无字幕，可以重试。", 502)
        self.add()
        self.drain()
        self.assertEqual(self.library.snapshot()["videos"][0]["transcriptStatus"], "unavailable")
        self.backend.caption_error = None
        self.library.request_transcript(entry()["id"])
        self.drain()
        self.assertEqual(self.library.get_transcript(entry()["id"])["language"], "zh-Hans")

    def test_corrupt_transcript_can_be_fetched_again(self):
        self.add()
        self.drain()
        (Path(self.temp.name) / "transcripts" / (entry()["id"] + ".json")).write_text("broken", encoding="utf-8")
        with self.assertRaises(s.ConnectorError):
            self.library.get_transcript(entry()["id"])
        self.library.request_transcript(entry()["id"])
        self.drain()
        self.assertTrue(self.library.get_transcript(entry()["id"])["segments"])

    def test_settings_validation_and_auto_off(self):
        for settings in ({"intervalMinutes": 0}, {"intervalMinutes": 5.5}, {"intervalMinutes": True},
                         {"intervalMinutes": 1441}, {"autoCaptions": "yes"}, {"unknown": 1}):
            with self.subTest(settings=settings), self.assertRaises(s.ConnectorError):
                self.library.update_settings(settings)
        self.library.update_settings({"intervalMinutes": 5, "autoCaptions": False})
        self.add()
        self.drain()
        self.assertFalse(self.backend.caption_calls)
        self.now += 300
        self.assertEqual(self.library.schedule_due(), 1)

    def test_corrupt_library_is_preserved(self):
        path = Path(self.temp.name) / "library.json"
        path.write_bytes(b"{corrupt old data")
        with self.assertRaises(s.ConnectorError):
            s.Library(self.temp.name, self.backend)
        self.assertEqual(path.read_bytes(), b"{corrupt old data")

    def test_snapshot_is_a_copy(self):
        self.add()
        snapshot = self.library.snapshot()
        snapshot["channels"].clear()
        snapshot["settings"]["intervalMinutes"] = 99
        self.assertEqual(len(self.library.snapshot()["channels"]), 1)
        self.assertEqual(self.library.snapshot()["settings"]["intervalMinutes"], 30)

    def test_concurrent_adds_do_not_duplicate(self):
        threads = [threading.Thread(target=self.add) for _ in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(self.library.snapshot()["channels"]), 1)
        self.assertEqual(self.library.jobs.qsize(), 1)

    def test_worker_thread_continues_and_stops(self):
        self.add()
        self.library.start()
        first_thread = self.library.worker
        self.library.start()
        self.assertIs(first_thread, self.library.worker)
        deadline = time.monotonic() + 5
        while self.library.jobs.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.02)
        self.assertEqual(self.library.jobs.unfinished_tasks, 0)
        self.library.close()
        self.assertFalse(self.library.worker.is_alive())

    def test_atomic_failure_keeps_previous_file(self):
        path = Path(self.temp.name) / "old.json"
        s.atomic_json(path, {"old": True})
        with patch.object(s.os, "replace", side_effect=PermissionError()), self.assertRaises(PermissionError):
            s.atomic_json(path, {"new": True})
        self.assertEqual(json.loads(path.read_text()), {"old": True})
        self.assertEqual(list(Path(self.temp.name).glob(".writing-*")), [])

    def test_disk_failure_does_not_kill_queue_consumer(self):
        self.add()
        with patch.object(self.library, "_save", side_effect=PermissionError("sensitive/path")):
            self.library.process_next()
        self.assertEqual(self.library.jobs.unfinished_tasks, 0)
        self.assertIn("本地资料库", self.library.snapshot()["error"])
        self.assertNotIn("sensitive", json.dumps(self.library.snapshot()))

    def test_stop_preserves_interrupted_job_as_pending(self):
        self.add()
        self.backend.callback = self.library.stop_event.set
        self.backend.channel_error = RuntimeError("interrupted")
        self.library.process_next()
        self.assertEqual(self.library.snapshot()["channels"][0]["status"], "pending")
        restored = s.Library(self.temp.name, FakeBackend(), clock=lambda: self.now)
        self.addCleanup(restored.close)
        self.assertEqual(restored.jobs.qsize(), 1)

    def test_invalid_caption_does_not_block_following_jobs(self):
        self.add()
        self.library.process_next()
        with patch.object(self.backend, "captions", return_value={"raw": "invalid", "format": "json3"}):
            self.library.process_next()
        self.drain()
        videos = self.library.snapshot()["videos"]
        self.assertEqual(videos[0]["transcriptStatus"], "error")
        self.assertEqual(videos[1]["transcriptStatus"], "ready")
        self.assertEqual(videos[2]["transcriptStatus"], "ready")

    def test_invalid_extractor_result_is_error_not_fake_success(self):
        self.backend.result = {"youtubeId": "bad", "videos": []}
        self.add()
        self.drain()
        self.assertEqual(self.library.snapshot()["channels"][0]["status"], "error")
        self.assertEqual(self.library.snapshot()["videos"], [])


class AuthHTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.library = s.Library(cls.temp.name, FakeBackend())
        cls.token = "test-" + "a" * 43
        cls.http = s.ConnectorHTTPServer((s.HOST, 0), cls.library, cls.token)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.port = cls.http.server_port

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join(timeout=3)
        cls.library.close()
        cls.temp.cleanup()

    def request(self, method, path, body=None, auth=True, origin=None, headers=None):
        connection = http.client.HTTPConnection(s.HOST, self.port, timeout=5)
        request_headers = {"Content-Type": "application/json"}
        if auth:
            request_headers["Authorization"] = "Bearer " + self.token
        if origin:
            request_headers["Origin"] = origin
        request_headers.update(headers or {})
        payload = json.dumps(body).encode() if body is not None else None
        connection.request(method, path, payload, headers=request_headers)
        response = connection.getresponse()
        data, response_headers, status = response.read(), dict(response.getheaders()), response.status
        connection.close()
        return status, json.loads(data) if data else None, response_headers

    def test_every_data_endpoint_requires_authentication(self):
        routes = [("GET", "/health"), ("GET", "/library"), ("POST", "/channels"), ("POST", "/sync"), ("POST", "/shutdown"),
                  ("PATCH", "/settings"), ("DELETE", "/channels/abc"),
                  ("GET", f"/videos/{VID}/transcript"), ("POST", f"/videos/{VID}/transcript"), ("GET", "/unknown")]
        for method, path in routes:
            with self.subTest(method=method, path=path):
                status, body, _ = self.request(method, path, auth=False)
                self.assertEqual(status, 401)
                self.assertEqual(body["code"], "UNAUTHORIZED")
                self.assertNotIn("token", json.dumps(body))

    def test_wrong_token_rejected(self):
        self.assertEqual(self.request("GET", "/health", headers={"Authorization": "Bearer wrong"})[0], 401)

    def test_health_and_library_shapes(self):
        status, body, _ = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"ok", "version", "workerRunning", "pid", "background", "capabilities"}
                         | ({"frameReason"} if not body["capabilities"]["videoFrames"] else set()))
        self.assertEqual(body["pid"], os.getpid())
        self.assertFalse(body["background"])
        self.assertEqual(set(self.request("GET", "/library")[1]), {"channels", "videos", "settings", "lastSync"})

    def test_host_constraint_prevents_rebinding(self):
        for host in ("evil.com", "127.0.0.1", f"localhost.evil.com:{self.port}", "127.0.0.1:9"):
            self.assertEqual(self.request("GET", "/library", headers={"Host": host})[0], 403)
        self.assertEqual(self.request("GET", "/health", headers={"Host": f"localhost:{self.port}"})[0], 200)

    def test_allowed_cors_requires_token_for_data(self):
        for origin in ("null", "http://localhost:5173", "https://127.0.0.1:7777"):
            status, _, headers = self.request("GET", "/health", origin=origin)
            self.assertEqual(status, 200)
            self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
            self.assertEqual(self.request("GET", "/library", origin=origin, auth=False)[0], 401)

    def test_untrusted_origin_rejected_even_with_token(self):
        status, _, headers = self.request("GET", "/library", origin="https://evil.com")
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_preflight_exposes_no_data_without_token(self):
        status, body, headers = self.request("OPTIONS", "/channels", auth=False, origin="null", headers={
            "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization,content-type",
            "Access-Control-Request-Private-Network": "true"})
        self.assertEqual(status, 204)
        self.assertIsNone(body)
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
        self.assertNotIn(self.token, str(headers))

    def test_invalid_preflight(self):
        self.assertEqual(self.request("OPTIONS", "/health", auth=False, origin="https://evil.com", headers={"Access-Control-Request-Method": "GET"})[0], 403)
        self.assertEqual(self.request("OPTIONS", "/health", auth=False, origin="null", headers={"Access-Control-Request-Method": "TRACE"})[0], 403)

    def test_api_add_settings_remove_and_invalid_channel(self):
        status, body, _ = self.request("POST", "/channels", {"url": "@HttpTest"})
        self.assertEqual(status, 202)
        channel_id = body["channel"]["id"]
        self.assertEqual(body["channel"]["status"], "pending")
        self.assertEqual(self.request("POST", "/sync", {"channelId": channel_id})[0], 202)
        self.assertEqual(self.request("PATCH", "/settings", {"autoCaptions": False})[0], 200)
        self.assertEqual(self.request("POST", "/channels", {"url": "https://evil.com"})[0], 400)
        self.assertEqual(self.request("DELETE", "/channels/" + channel_id)[0], 200)

    def test_invalid_json_and_limits(self):
        self.assertEqual(self.request("POST", "/channels", [1, 2])[0], 400)
        self.assertEqual(self.request("POST", "/channels", {"url": "a" * 9000})[0], 413)
        self.assertEqual(self.request("POST", "/channels", {"url": "@Example"}, headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request("POST", "/sync", {"channelId": 123})[0], 400)

    def test_missing_video_and_ready_transcript_contract(self):
        self.assertEqual(self.request("GET", f"/videos/{VID}/transcript")[0], 404)
        identifier = self.library.add_channel("@HttpTranscript")["channel"]["id"]
        self.library.update_settings({"autoCaptions": False})
        while self.library.process_next():
            pass
        video_id = entry()["id"]
        self.assertEqual(self.request("GET", f"/videos/{video_id}/transcript")[0], 409)
        self.assertEqual(self.request("POST", f"/videos/{video_id}/transcript")[0], 202)
        while self.library.process_next():
            pass
        status, body, _ = self.request("GET", f"/videos/{video_id}/transcript")
        self.assertEqual(status, 200)
        self.assertEqual(set(body), {"segments", "language", "source", "raw", "format"})
        self.library.remove_channel(identifier)


class BackendTests(unittest.TestCase):
    def test_subprocess_uses_argument_array_isolation_and_no_shell(self):
        process = MagicMock()
        process.wait.return_value = 0
        def spawn(command, **kwargs):
            self.assertIsInstance(command, list)
            self.assertEqual(command[1], "-I")
            self.assertFalse(kwargs["shell"])
            self.assertEqual(command[-2], "https://www.youtube.com/@Example/videos")
            Path(command[-1]).write_text(json.dumps({"ok": True, "data": channel_result()}), encoding="utf-8")
            return process
        with patch.object(s.subprocess, "Popen", side_effect=spawn):
            self.assertEqual(s.YtDlpBackend().channel("https://www.youtube.com/@Example")["youtubeId"], CID)
        process.wait.assert_called_once_with(timeout=75)

    def test_timeout_kills_child_and_returns_recoverable_error(self):
        process = MagicMock()
        process.wait.side_effect = [s.subprocess.TimeoutExpired("redacted", 75), 0]
        backend = s.YtDlpBackend()
        with patch.object(s.subprocess, "Popen", return_value=process):
            with self.assertRaises(s.ConnectorError) as raised:
                backend.channel("https://www.youtube.com/@Example")
        self.assertEqual(raised.exception.code, "NETWORK_TIMEOUT")
        self.assertTrue(raised.exception.retryable)
        process.kill.assert_called_once()
        self.assertIsNone(backend.active)

    def test_external_error_details_are_not_returned(self):
        def spawn(command, **kwargs):
            Path(command[-1]).write_text(json.dumps({"ok": False, "code": "secret-cookie-url"}), encoding="utf-8")
            return MagicMock()
        with patch.object(s.subprocess, "Popen", side_effect=spawn), self.assertRaises(s.ConnectorError) as raised:
            s.YtDlpBackend().channel("https://www.youtube.com/@Example")
        self.assertEqual(raised.exception.code, "EXTRACTOR_FAILED")
        self.assertNotIn("secret", str(raised.exception))


class TokenTests(unittest.TestCase):
    def test_random_token_persisted_without_rotation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connection.json"
            token = s.connection_token(path)
            self.assertGreaterEqual(len(token), 43)
            self.assertNotEqual(token, s.connection_token(path))
            s.atomic_json(path, {"url": "http://127.0.0.1:18743", "token": token})
            self.assertEqual(token, s.connection_token(path))

    def test_invalid_connection_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "connection.json"
            path.write_text('{"token":"bad"}', encoding="utf-8")
            with self.assertRaises(s.ConnectorError):
                s.connection_token(path)
            self.assertEqual(path.read_text(), '{"token":"bad"}')

    def test_exclusive_instance_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "instance.lock"
            with s.InstanceLock(path):
                with self.assertRaises(s.ConnectorError):
                    with s.InstanceLock(path):
                        self.fail("second lock acquired")
            with s.InstanceLock(path):
                pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
