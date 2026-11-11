"""显式安装已授权的专用Clash入口，不复制或输出代理凭据。"""
from __future__ import annotations
import argparse
import copy
import json
import re
import socket
import sys
from pathlib import Path
import yaml
if __package__:
    from .caption_pool import ClashController, GROUP, PoolError, save_json
else:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from caption_pool import ClashController, GROUP, PoolError, save_json


def enhanced_config(config):
    config = copy.deepcopy(config)
    names = [p.get("name") for p in config.get("proxies", []) if isinstance(p.get("name"), str)]
    us_group = next((g for g in config.get("proxy-groups", []) if g.get("name") == "🇺🇸 美国手动"), None)
    candidates = us_group.get("proxies", []) if us_group else [n for n in names if re.search("🇺🇸|美國|美国|USA|US-Home", n)]
    chosen = list(dict.fromkeys(n for n in candidates if n in names and n not in ("DIRECT", "REJECT", "GLOBAL")))[:64]
    if not chosen:
        # 无美国分组的其它订阅保留此前的三节点兼容入口。
        chosen = names[:3]
    if not chosen:
        raise PoolError("NO_NODES", "当前配置没有可用节点，未安装专用入口。")
    groups = config.setdefault("proxy-groups", [])
    if any(g.get("name") == GROUP for g in groups):
        raise PoolError("ALREADY_CONFIGURED", "已存在专用组；请先检查现有配置，不覆盖它。")
    groups.append({"name": GROUP, "type": "select", "proxies": chosen})
    listeners = config.setdefault("listeners", [])
    if any(x.get("name") == "yingdu-captions" or x.get("port") == 18883 for x in listeners):
        raise PoolError("PORT_CONFLICT", "专用入口或端口已存在，未覆盖。")
    listeners.append({"name": "yingdu-captions", "type": "http", "listen": "127.0.0.1", "port": 18883, "proxy": GROUP, "users": []})
    return config, chosen


def install(config_path, data_dir, report_path):
    controller = ClashController(config_path)
    before = controller.request("GET", "/proxies").get("proxies", {})
    selected = {n: x["now"] for n, x in before.items() if x.get("type") == "Selector" and "now" in x}
    runtime = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    already_present = GROUP in before
    source = copy.deepcopy(runtime)
    if already_present:
        # 处理“配置已生效但安装回执中断”：仅核验并接管，绝不重复重载。
        source["proxy-groups"] = [g for g in source.get("proxy-groups", []) if g.get("name") != GROUP]
        source["listeners"] = [l for l in source.get("listeners", []) if l.get("name") != "yingdu-captions"]
    config, chosen = enhanced_config(source)
    if already_present:
        if controller.members() != chosen:
            raise PoolError("POOL_CONFLICT", "已有专用组与预期不符，未覆盖。")
    else:
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 18883))
        # payload仅通过本机命名管道传递；不写出含密钥的完整配置或底层响应。
        controller.request("PUT", "/configs?force=false", {"payload": yaml.safe_dump(config, allow_unicode=True)})
        import time
        time.sleep(0.5)
    from urllib.parse import quote
    after = controller.request("GET", "/proxies").get("proxies", {})
    restored = []
    for name, value in selected.items():
        if after.get(name, {}).get("now") != value:
            controller.request("PUT", "/proxies/" + quote(name, safe=""), {"name": value})
            restored.append(name)
    verified = controller.request("GET", "/proxies").get("proxies", {})
    if not all(verified.get(n, {}).get("now") == v for n, v in selected.items()):
        raise PoolError("SELECTION_CHANGED", "原代理选择未完全恢复，请检查Clash；不宣称安装完成。")
    if controller.members() != chosen:
        raise PoolError("POOL_INVALID", "专用节点组验证失败，不宣称安装完成。")
    with socket.create_connection(("127.0.0.1", 18883), timeout=3):
        pass
    settings = {"enabled": True, "clashConfig": str(config_path.resolve()), "group": GROUP, "proxyUrl": "http://127.0.0.1:18883"}
    save_json(data_dir / "connector" / "caption-proxy.json", settings)
    report = {"installed": True, "group": GROUP, "port": 18883, "nodeCount": len(chosen), "nodes": chosen, "existingSelectors": len(selected), "existingSelectionsPreserved": True, "restoredSelectors": restored, "globalRulesUnchanged": config.get("rules") == runtime.get("rules"), "globalModeUnchanged": config.get("mode") == runtime.get("mode")}
    save_json(report_path, report)
    print(json.dumps(report, ensure_ascii=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="为映读显式安装Clash专用字幕入口")
    parser.add_argument("--clash-config", required=True, type=Path)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--report", required=True, type=Path)
    args = parser.parse_args()
    try:
        install(args.clash_config, args.data_dir, args.report)
    except (PoolError, OSError, ValueError):
        print("专用出口安装未完成；请检查Clash配置及本机端口。没有输出密钥或完整响应。")
        raise SystemExit(1)
