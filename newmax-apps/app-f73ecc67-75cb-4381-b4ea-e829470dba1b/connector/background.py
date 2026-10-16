"""无控制台入口：复用服务及单实例锁，只保留脱敏运行日志。"""
from __future__ import annotations

import argparse
import contextlib
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import sys

# -I 禁用环境注入；只加入本应用受信任的源码目录。
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server


class LogStream:
    def __init__(self, logger):
        self.logger = logger

    def write(self, value):
        text = value.strip()
        if text:
            self.logger.info(text)
        return len(value)

    def flush(self):
        pass


def run(data_dir):
    directory = Path(data_dir) / "connector"
    directory.mkdir(parents=True, exist_ok=True)
    try:
        # 重复启动不打开或轮转正在使用的日志。
        with server.InstanceLock(directory / "background.lock"):
            handler = RotatingFileHandler(directory / "background.log", maxBytes=512 * 1024,
                                          backupCount=2, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
            logger = logging.getLogger("yingdu.background")
            logger.setLevel(logging.INFO)
            logger.propagate = False
            logger.addHandler(handler)
            try:
                stream = LogStream(logger)
                with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
                    return server.main(["--data-dir", str(data_dir), "--background"])
            finally:
                logger.removeHandler(handler)
                handler.close()
    except server.ConnectorError as error:
        if error.code == "ALREADY_RUNNING":
            return 0
        return 1
    except OSError:
        # 不打印任意异常内容、用户路径或凭据。
        return 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="映读静默连接器")
    parser.add_argument("--data-dir", type=Path, default=server.APP_DATA)
    raise SystemExit(run(parser.parse_args().data_dir))
