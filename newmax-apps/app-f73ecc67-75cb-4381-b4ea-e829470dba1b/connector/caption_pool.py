"""只操作已授权的字幕专用组；密钥始终留在Clash配置与本机控制通道。"""
from __future__ import annotations
import ctypes
import http.client
import io
import json
import os
import re
import threading
import time
from pathlib import Path
from urllib.parse import quote, urlsplit
from urllib.request import Request, build_opener, ProxyHandler, HTTPRedirectHandler

GROUP = "映读字幕专用"

class PoolError(Exception):
    def __init__(self, code, message):
        self.code, self.message = code, message
        super().__init__(message)


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".new")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(value, f, ensure_ascii=False, allow_nan=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


class PipeReader(io.RawIOBase):
    def __init__(self, pipe, deadline):
        self.pipe, self.deadline = pipe, deadline
    def readable(self):
        return True
    def readinto(self, target):
        import msvcrt
        from ctypes import wintypes
        available = wintypes.DWORD()
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.PeekNamedPipe.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
        while time.monotonic() < self.deadline:
            ok = kernel.PeekNamedPipe(msvcrt.get_osfhandle(self.pipe.fileno()), None, 0, None, ctypes.byref(available), None)
            if not ok:
                if ctypes.get_last_error() in (109, 232):
                    return 0
                raise OSError("本机控制管道读取失败")
            if available.value:
                data = self.pipe.read(min(len(target), available.value))
                target[:len(data)] = data
                return len(data)
            time.sleep(0.02)
        raise TimeoutError("本机控制管道超时")


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise OSError("本机控制接口不允许重定向")


class ClashController:
    def __init__(self, config_path):
        self.config_path = Path(config_path)

    def request(self, method, path, data=None):
        try:
            import yaml
            config = yaml.safe_load(self.config_path.read_text(encoding="utf-8"))
            secret = str(config.get("secret") or "")
            if re.search(r"[\r\n]", secret) or len(secret) > 512:
                raise ValueError()
            payload = json.dumps(data, ensure_ascii=False).encode() if data is not None else b""
            if len(payload) > 16 * 1024 * 1024:
                raise ValueError()
            headers = {"Authorization": "Bearer " + secret, "Content-Type": "application/json"}
            address = config.get("external-controller")
            if isinstance(address, str) and re.fullmatch(r"127\.0\.0\.1:\d{1,5}", address):
                with build_opener(ProxyHandler({}), NoRedirect()).open(Request("http://" + address + path, data=payload if data is not None else None, method=method, headers=headers), timeout=8) as r:
                    raw, status = r.read(2 * 1024 * 1024 + 1), r.status
            else:
                sep = chr(92)
                root = sep * 2 + "." + sep + "pipe" + sep
                declared = str(config.get("external-controller-pipe") or "")
                suffix = re.search(r"([a-f0-9]{64})$", declared)
                if not suffix:
                    raise ValueError()
                names = [n for n in os.listdir(root) if n.startswith("verge-mihomo-") and n.endswith(suffix[1])]
                if len(names) != 1:
                    raise ValueError()
                with open(root + names[0], "r+b", buffering=0) as pipe:
                    request = (method + " " + path + " HTTP/1.1\r\nHost: localhost\r\n" + "".join(k + ": " + v + "\r\n" for k, v in headers.items()) + "Content-Length: " + str(len(payload)) + "\r\nConnection: close\r\n\r\n").encode() + payload
                    offset = 0
                    while offset < len(request):
                        offset += pipe.write(request[offset:])
                    reader = io.BufferedReader(PipeReader(pipe, time.monotonic() + 8))
                    socket = type("PipeSocket", (), {"makefile": lambda self, *a, **k: reader})()
                    response = http.client.HTTPResponse(socket)
                    response.begin()
                    raw, status = response.read(2 * 1024 * 1024 + 1), response.status
                    response.close()
            if not 200 <= status < 300 or len(raw) > 2 * 1024 * 1024:
                raise ValueError()
            return json.loads(raw) if raw else {}
        except (OSError, ValueError, KeyError, TypeError, http.client.HTTPException, ImportError) as cause:
            error = PoolError("CLASH_UNAVAILABLE", "无法连接Clash专用节点控制接口；请确认Clash正在运行并保留映读专用配置。不会改用全局出口。")
            error.diagnostic = {"type": type(cause).__name__, "status": locals().get("status"), "errno": getattr(cause, "errno", None)}
            raise error from None

    def members(self):
        value = self.request("GET", "/proxies/" + quote(GROUP, safe=""))
        if value.get("type") != "Selector":
            raise PoolError("POOL_INVALID", "Clash中缺少映读专用节点组，请重新配置专用出口。")
        nodes = value.get("all")
        if not isinstance(nodes, list) or not 1 <= len(nodes) <= 64 or any(not isinstance(n, str) or n in ("DIRECT", "REJECT", "GLOBAL") or len(n) > 256 for n in nodes):
            raise PoolError("POOL_INVALID", "专用节点组无有效节点；不会切换全局代理。")
        return nodes

    def select(self, node):
        self.request("PUT", "/proxies/" + quote(GROUP, safe=""), {"name": node})
        value = self.request("GET", "/proxies/" + quote(GROUP, safe=""))
        if value.get("now") != node:
            raise PoolError("CLASH_UNAVAILABLE", "Clash未确认专用节点切换，已停止本次获取。")


class CaptionPool:
    def __init__(self, directory, controller=None, clock=time.time, sleeper=time.sleep):
        self.directory, self.clock, self.sleeper = Path(directory), clock, sleeper
        self.path = self.directory / "caption-pool-state.json"
        self.config_path = self.directory / "caption-proxy.json"
        self.controller = controller
        self.lock = threading.RLock()
        self.running = False
        self.config, self.state = {}, {"cooldowns": {}, "lastRequest": 0, "lastNode": None, "lastError": None}
        try:
            if self.config_path.exists():
                self.config = json.loads(self.config_path.read_text(encoding="utf-8"))
                url = urlsplit(self.config.get("proxyUrl", ""))
                if self.config.get("group") != GROUP or url.scheme != "http" or url.hostname != "127.0.0.1" or url.port is None or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment:
                    raise ValueError()
                if not 1024 <= url.port <= 65535:
                    raise ValueError()
                self.controller = controller or ClashController(self.config["clashConfig"])
            if self.path.exists():
                self.state = json.loads(self.path.read_text(encoding="utf-8"))
                if not isinstance(self.state.get("cooldowns"), dict):
                    raise ValueError()
        except (OSError, ValueError, KeyError, TypeError):
            raise PoolError("POOL_CONFIG_INVALID", "字幕节点池配置或冷却记录损坏，已保留原文件；不会静默清空冷却或切换全局出口。") from None
        self.nodes = []

    @property
    def enabled(self):
        return self.config.get("enabled") is True

    def _save(self):
        save_json(self.path, self.state)

    def status(self):
        with self.lock:
            now = self.clock()
            available = [n for n in self.nodes if self.state["cooldowns"].get(n, 0) <= now]
            cooling = [self.state["cooldowns"].get(n, 0) for n in self.nodes if self.state["cooldowns"].get(n, 0) > now]
            return {"enabled": self.enabled, "nodeCount": len(self.nodes), "available": len(available), "cooling": len(cooling), "nextAvailableAt": min(cooling) if cooling else None, "running": self.running, "lastNode": self.state.get("lastNode"), "lastError": self.state.get("lastError"), "maxAttempts": 3, "intervalSeconds": 20, "paidFallback": "not_configured"}

    def warmup(self):
        if self.enabled:
            try:
                self.nodes = self.controller.members()
                self.state["lastError"] = None
            except PoolError as e:
                self.state["lastError"] = e.message
        return self.status()

    def fetch(self, call, stopping=lambda: False):
        if not self.enabled:
            return call(None)
        self.running = True
        tried = []
        try:
            self.nodes = self.controller.members()
            for _ in range(3):
                now = self.clock()
                candidates = [n for n in self.nodes if n not in tried and self.state["cooldowns"].get(n, 0) <= now]
                if not candidates:
                    raise PoolError("CAPTION_COOLDOWN", "字幕专用出口正在冷却，本次已暂停。请待冷却结束后手动获取；不会反复请求或自动扣费。")
                # 优先上次成功出口；失败节点会被冷却排除。
                last = self.state.get("lastNode")
                node = last if last in candidates else candidates[0]
                while self.clock() < self.state.get("lastRequest", 0) + 20:
                    if stopping():
                        raise PoolError("STOPPING", "连接器正在停止，本次任务保留。")
                    self.sleeper(min(0.25, self.state["lastRequest"] + 20 - self.clock()))
                if stopping():
                    raise PoolError("STOPPING", "连接器正在停止，本次任务保留。")
                self.controller.select(node)
                tried.append(node)
                self.state.update(lastRequest=self.clock(), lastNode=node, lastError=None)
                self._save()
                try:
                    result = call(self.config["proxyUrl"])
                    self.state["lastError"] = None
                    self._save()
                    return result
                except Exception as e:
                    code = getattr(e, "code", "")
                    if code not in ("RATE_LIMITED", "NETWORK_ERROR", "NETWORK_TIMEOUT", "EXTRACTOR_FAILED", "CAPTION_LIST_UNAVAILABLE"):
                        raise
                    cooldown = 1800 if code == "RATE_LIMITED" else 300
                    retry_after = getattr(e, "retry_after", 0)
                    if isinstance(retry_after, (int, float)) and not isinstance(retry_after, bool):
                        cooldown = max(cooldown, min(86400, max(0, retry_after)))
                    self.state["cooldowns"][node] = self.clock() + cooldown
                    self.state["lastError"] = "YouTube字幕接口限流（HTTP 429），已冷却该出口并有限切换。" if code == "RATE_LIMITED" else "当前专用出口连接失败，已冷却并有限切换。"
                    self._save()
            raise PoolError("CAPTION_COOLDOWN", "本次最多3个专用节点均未获取到字幕，已停止尝试并保留冷却。稍后可手动获取；付费备用尚未配置。")
        except PoolError as e:
            self.state["lastError"] = e.message
            self._save()
            raise
        finally:
            self.running = False
