"""日期补取专项：隔离资料库，不访问真实YouTube。"""
import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from connector import server as s, yt_worker as yt
from connector.test_server import FakeBackend, entry, caption_result
from connector import test_server as fixtures

DATE = "2026-10-15T00:00:00Z"


class ProtectedContentTests(unittest.TestCase):
    def test_cache_timestamp_ignored_but_content_change_detected(self):
        from connector.refresh_dates import protected_hashes
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            path = directory / "kv.json"
            data = {"entries": {"yingdu.transcript.test": {"value": {"segments": ["原文"]}, "updatedAt": "old"}}}
            path.write_text(json.dumps(data), encoding="utf-8")
            before = protected_hashes(directory)
            data["entries"]["yingdu.transcript.test"]["updatedAt"] = "new"
            path.write_text(json.dumps(data), encoding="utf-8")
            self.assertEqual(before, protected_hashes(directory))
            data["entries"]["yingdu.transcript.test"]["value"]["segments"] = ["改变"]
            path.write_text(json.dumps(data), encoding="utf-8")
            self.assertNotEqual(before, protected_hashes(directory))


class DateParsingTests(unittest.TestCase):
    def test_absolute_dates_and_invalid_timestamp_fallback(self):
        self.assertEqual(yt.publication_date({"timestamp": 1767225600, "upload_date": "20261015"}), "2026-01-01T00:00:00Z")
        for value in (None, True, float("inf"), float("nan"), 1e99, "bad", -1):
            with self.subTest(value=value):
                self.assertEqual(yt.publication_date({"timestamp": value, "upload_date": "20261015"}), DATE)

    def test_no_guessed_or_invalid_dates(self):
        for value in ("20260230", "20261301", "yesterday", "2026-10-15", "", None, 20261015):
            self.assertIsNone(yt.publication_date({"upload_date": value}))
        self.assertIsNone(yt.publication_date({"release_timestamp": 1767225600, "relative_date": "2 days ago"}))

    def test_metadata_action_uses_watch_url_and_no_download(self):
        backend = s.YtDlpBackend()
        with patch.object(backend, "_call", return_value={"publishedAt": DATE}) as call:
            self.assertEqual(backend.metadata("abcdefghijk"), {"publishedAt": DATE})
            call.assert_called_once_with("metadata", "https://www.youtube.com/watch?v=abcdefghijk")
        with self.assertRaises(s.ConnectorError):
            backend.metadata("https://evil.com")
        self.assertTrue(yt.options("metadata")["skip_download"])
        self.assertNotIn("extract_flat", yt.options("metadata"))

    def test_worker_metadata_action_and_identity_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "result.json"
            fake = MagicMock()
            fake.YoutubeDL.return_value.__enter__.return_value.extract_info.return_value = {
                "id": "abcdefghijk", "upload_date": "20261015"}
            with patch.dict("sys.modules", {"yt_dlp": fake}), patch.object(yt.sys, "argv", [
                "yt_worker.py", "metadata", "https://www.youtube.com/watch?v=abcdefghijk", str(output)
            ]):
                self.assertEqual(yt.main(), 0)
                self.assertEqual({k:v for k,v in json.loads(output.read_text())["data"].items() if k in ("publishedAt", "datePrecision")}, {"publishedAt": DATE, "datePrecision": "day"})
                fake.YoutubeDL.return_value.__enter__.return_value.extract_info.assert_called_with(
                    "https://www.youtube.com/watch?v=abcdefghijk", download=False)
                fake.YoutubeDL.return_value.__enter__.return_value.extract_info.return_value["id"] = "differentID"
                self.assertEqual(yt.main(), 1)
                self.assertEqual(json.loads(output.read_text())["code"], "INVALID_RESPONSE")


class DateLibraryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.backend = FakeBackend()
        self.backend.metadata = MagicMock(return_value={"publishedAt": DATE})
        self.lib = s.Library(self.temp.name, self.backend)
        self.addCleanup(self.lib.close)
        self.lib.state["videos"] = [dict(entry(i), transcriptStatus="ready", transcriptError=None,
                                         summary="不能覆盖", favorite=True) for i in range(25)]
        self.lib._save()

    def drain(self):
        for _ in range(100):
            if not self.lib.process_next():
                return
        self.fail("任务未结束")

    def test_all_records_not_only_recent_twenty_and_dedup(self):
        before = copy.deepcopy(self.lib.state["videos"])
        self.assertEqual(self.lib.refresh_dates()["queued"], 25)
        self.lib.process_next()
        self.assertEqual(self.lib.refresh_dates()["queued"], 0)
        self.drain()
        self.assertEqual(self.backend.metadata.call_count, 25)
        self.assertEqual(self.backend.caption_calls, [])
        self.assertEqual(self.backend.channel_calls, [])
        for old, new in zip(before, self.lib.state["videos"]):
            self.assertEqual(new["publishedAt"], DATE)
            self.assertEqual(new["dateStatus"], "ready")
            self.assertEqual({k: v for k, v in new.items() if k not in ("publishedAt", "datePrecision", "dateStatus", "dateError")},
                             {k: v for k, v in old.items() if k != "publishedAt"})

    def test_missing_and_network_failure_preserve_known_date(self):
        self.lib.state["videos"][0]["publishedAt"] = DATE
        self.backend.metadata.side_effect = [{"publishedAt": None}, s.ConnectorError("NETWORK_TIMEOUT", "超时", 502)] + [{"publishedAt": DATE}] * 23
        self.lib.refresh_dates()
        self.drain()
        videos = self.lib.state["videos"]
        self.assertEqual(videos[0]["publishedAt"], DATE)
        self.assertEqual(videos[0]["dateStatus"], "unavailable")
        self.assertIsNone(videos[1]["publishedAt"])
        self.assertEqual(videos[1]["dateStatus"], "error")
        self.assertEqual(videos[1]["transcriptStatus"], "ready")
        self.assertTrue(all(v["dateStatus"] == "ready" for v in videos[2:]))

    def test_reload_recovers_only_pending_jobs(self):
        self.lib.refresh_dates()
        self.lib.process_next()
        self.lib.state["videos"][1]["dateStatus"] = "fetching"
        self.lib._save()
        restored = s.Library(self.temp.name, self.backend)
        self.addCleanup(restored.close)
        self.assertEqual(restored.jobs.qsize(), 24)
        self.assertEqual(restored.state["videos"][0]["publishedAt"], DATE)
        self.assertEqual(restored.state["videos"][1]["dateStatus"], "pending")

    def test_stop_preserves_pending_status_and_old_date(self):
        self.lib.state["videos"][0]["publishedAt"] = DATE
        self.lib.refresh_dates()
        self.backend.metadata.side_effect = s.ConnectorError("STOPPING", "停止", 503)
        self.lib.stop_event.set()
        self.lib.process_next()
        self.assertEqual(self.lib.state["videos"][0]["dateStatus"], "pending")
        self.assertEqual(self.lib.state["videos"][0]["publishedAt"], DATE)

    def test_resync_empty_date_does_not_erase(self):
        self.lib.state["settings"]["autoCaptions"] = False
        self.lib.state["videos"][0]["publishedAt"] = DATE
        self.lib.add_channel("@Example")
        self.drain()
        self.assertEqual(self.lib.state["videos"][0]["publishedAt"], DATE)
        self.assertEqual(self.backend.metadata.call_count, 4)  # 仅查同频道的四条缺项，已知日期不重取。

    def test_relative_channel_dates_are_explicit_and_enable_parser(self):
        self.assertEqual(yt.options("channel")["extractor_args"]["youtubetab"], {"approximate_date": ["true"]})
        self.assertNotIn("youtubetab", yt.options("metadata")["extractor_args"])
        result = yt.channel_result({"id": fixtures.CID, "entries": [{"id": "abcdefghijk", "timestamp": 1767225600}]})
        self.assertEqual(result["videos"][0]["publishedAt"], "2026-01-01T00:00:00Z")
        self.assertEqual(result["videos"][0]["datePrecision"], "approximate")

    def test_missing_only_preserves_all_known_dates(self):
        self.lib.state["videos"][0].update(publishedAt=DATE, datePrecision="day")
        self.lib.state["videos"][1].update(publishedAt=DATE, datePrecision="approximate")
        self.assertEqual(self.lib.refresh_dates(missing_only=True)["queued"], 24)
        self.drain()
        self.assertEqual(self.backend.metadata.call_count, 24)
        self.assertEqual(self.lib.state["videos"][0]["datePrecision"], "day")
        self.assertEqual(self.lib.state["videos"][1]["datePrecision"], "day")

    def test_missing_only_joins_existing_metadata_without_losing_other_targets(self):
        self.lib.state["videos"][0]["dateStatus"] = "pending"
        self.lib._queue("metadata", self.lib.state["videos"][0]["id"])
        self.assertEqual(self.lib.refresh_dates(missing_only=True)["queued"], 24)
        self.assertEqual(self.lib.refresh_dates(missing_only=True)["queued"], 0)
        self.drain()
        self.assertEqual(self.backend.metadata.call_count, 25)

    def test_channel_approximate_cannot_overwrite_exact_and_backfills_without_captions(self):
        video = self.lib.state["videos"][0]
        video.update(publishedAt=DATE, datePrecision="second")
        self.lib.state["settings"]["autoCaptions"] = False
        self.backend.result["videos"][0].update(publishedAt="2026-10-01T00:00:00Z", datePrecision="approximate")
        self.backend.result["videos"][1].update(publishedAt="2026-10-14T23:00:00Z", datePrecision="approximate")
        self.lib.add_channel("@Example")
        self.lib.process_next()
        self.assertEqual(video["publishedAt"], DATE)
        self.assertEqual(video["datePrecision"], "second")
        self.assertEqual(self.lib.state["videos"][1]["dateStatus"], "pending")
        self.drain()
        self.assertEqual(self.backend.metadata.call_count, 4)
        self.assertEqual(self.backend.caption_calls, [])
        self.assertEqual(self.lib.state["videos"][1]["datePrecision"], "day")

    def test_caption_result_backfills_without_overwriting_other_content(self):
        video = self.lib.state["videos"][0]
        video["transcriptStatus"] = "none"
        self.backend.captions = MagicMock(return_value={**caption_result(), "publishedAt": DATE})
        self.lib.request_transcript(video["id"])
        self.drain()
        self.assertEqual(video["publishedAt"], DATE)
        self.assertEqual(video["summary"], "不能覆盖")
        self.assertEqual(video["transcriptStatus"], "ready")
        video["transcriptStatus"] = "none"
        self.backend.captions.return_value = caption_result()
        self.lib.request_transcript(video["id"])
        self.drain()
        self.assertEqual(video["publishedAt"], DATE)


# 复用回环服务器夹具，不重复继承全部HTTP测试。
class DateHTTPTests(unittest.TestCase):
    setUpClass = classmethod(fixtures.AuthHTTPTests.setUpClass.__func__)
    tearDownClass = classmethod(fixtures.AuthHTTPTests.tearDownClass.__func__)
    request = fixtures.AuthHTTPTests.request

    def test_refresh_requires_auth_and_rejects_extra_fields(self):
        self.assertEqual(self.request("POST", "/dates/refresh", {}, auth=False)[0], 401)
        self.assertEqual(self.request("POST", "/dates/refresh", {}, origin="https://evil.com")[0], 403)
        self.assertEqual(self.request("POST", "/dates/refresh", {"url": "https://evil.com"})[0], 400)
        self.assertEqual(self.request("POST", "/dates/refresh", {"missingOnly": "yes"})[0], 400)
        self.assertEqual(self.request("POST", "/dates/refresh", {"missingOnly": True})[0], 202)
        status, body, _ = self.request("POST", "/dates/refresh", {})
        self.assertEqual(status, 202)
        self.assertEqual(body, {"ok": True, "queued": 0, "total": 0})


if __name__ == "__main__":
    unittest.main()
