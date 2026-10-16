"""静默生命周期测试：只使用临时目录、随机端口与假后端。"""
import http.client
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from connector import background as b
from connector import server as s
from connector.test_server import FakeBackend


class BackgroundTests(unittest.TestCase):
    def test_reuses_main_and_logs_without_console(self):
        with tempfile.TemporaryDirectory() as directory:
            def main(args):
                self.assertEqual(args, ["--data-dir", directory, "--background"])
                print("连接器已启动")
                return 0
            with patch.object(b.server, "main", side_effect=main), patch.object(b.sys, "stdout", None), patch.object(b.sys, "stderr", None):
                self.assertEqual(b.run(directory), 0)
            self.assertIn("连接器已启动", (Path(directory) / "connector/background.log").read_text(encoding="utf-8"))

    def test_duplicate_background_does_not_start_or_rewrite_log(self):
        with tempfile.TemporaryDirectory() as directory:
            with b.server.InstanceLock(Path(directory) / "connector/background.lock"), patch.object(b.server, "main") as main:
                self.assertEqual(b.run(directory), 0)
                main.assert_not_called()
            self.assertFalse((Path(directory) / "connector/background.log").exists())

    def test_failed_main_keeps_failure_code_and_releases_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(b.server, "main", return_value=1):
                self.assertEqual(b.run(directory), 1)
            with patch.object(b.server, "main", return_value=0):
                self.assertEqual(b.run(directory), 0)

    def test_shutdown_auth_origin_body_and_health(self):
        with tempfile.TemporaryDirectory() as directory:
            library = s.Library(directory, FakeBackend())
            library.start()
            server = s.ConnectorHTTPServer((s.HOST, 0), library, "a" * 43)
            server.background = True
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            def request(method, path, auth=True, origin="null", body="{}"):
                connection = http.client.HTTPConnection(s.HOST, server.server_port, timeout=3)
                headers = {"Content-Type": "application/json", "Origin": origin}
                if auth:
                    headers["Authorization"] = "Bearer " + "a" * 43
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                result = (response.status, json.loads(response.read()))
                connection.close()
                return result
            try:
                health = request("GET", "/health")[1]
                self.assertTrue(health["workerRunning"])
                self.assertTrue(health["background"])
                self.assertEqual(health["pid"], os.getpid())
                self.assertEqual(request("POST", "/shutdown", auth=False)[0], 401)
                self.assertEqual(request("POST", "/shutdown", origin="https://evil.example")[0], 403)
                self.assertEqual(request("POST", "/shutdown", body="invalid")[0], 400)
                self.assertTrue(thread.is_alive())
                status, value = request("POST", "/shutdown")
                self.assertEqual(status, 200)
                self.assertTrue(value["stopping"])
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
            finally:
                server.shutdown()
                server.server_close()
                library.close()
            self.assertFalse(library.worker.is_alive())


if __name__ == "__main__":
    unittest.main()
