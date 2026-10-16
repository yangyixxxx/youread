"""隔离启动入口回归，不监听端口、不访问用户资料或网络。"""
import subprocess
import sys
import unittest
from pathlib import Path


class StandaloneTests(unittest.TestCase):
    def test_isolated_server_help_loads_local_frame_module(self):
        entry = Path(__file__).with_name('server.py')
        result = subprocess.run([sys.executable, '-I', str(entry), '--help'],
                                capture_output=True, timeout=10,
                                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        self.assertEqual(result.returncode, 0, result.stderr.decode('utf-8', errors='replace'))
        self.assertIn(b'--data-dir', result.stdout)


if __name__ == '__main__':
    unittest.main()
