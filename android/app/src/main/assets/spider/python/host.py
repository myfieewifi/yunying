"""Android 端 Python spider host（Chaquopy 嵌入式）。

API 对齐映匣 Runtime/PythonHost/host.py 的 Spider 协议：
    Spider().init(ext)
    Spider().homeContent(filter) -> str (JSON)
    Spider().categoryContent(tid, pg, filter, ex) -> str (JSON)
    Spider().searchContent(wd, quick, pg) -> str (JSON)
    Spider().detailContent(ids) -> list[dict] | str JSON
    Spider().playerContent(flag, id, vipFlags) -> dict

此文件暴露 load_spider(script_path, ext) 给 PySpider.kt 调用，加载用户 .py 爬虫并返回实例。
"""
import os
import sys
import importlib.util
from hashlib import sha256

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)


def _load_source(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_spider(script_path, ext):
    name = "tvbox_spider_" + sha256(script_path.encode()).hexdigest()[:16]
    mod = _load_source(name, script_path)
    if not hasattr(mod, "Spider"):
        raise RuntimeError("Python script does not define a Spider class: " + script_path)
    inst = mod.Spider()
    inst.extend = ext or ""
    for dep in (inst.getDependence() or []):
        _load_dependency(dep, os.path.dirname(script_path), inst)
    if hasattr(inst, "init"):
        inst.init(ext or "")
    return inst


def _load_dependency(name, base_dir, inst):
    if not isinstance(name, str) or not name:
        return
    path = os.path.join(base_dir, name + ".py")
    if os.path.exists(path):
        _load_source(name, path)
    else:
        # 远程下载依赖
        try:
            url = name if name.startswith("http") else None
            if url:
                r = requests.get(url, timeout=15, headers={"User-Agent": "Mozilla/5.0"})
                r.raise_for_status()
                cache = os.path.join(os.path.expanduser("~"), ".tvbox_py_modules")
                os.makedirs(cache, exist_ok=True)
                target = os.path.join(cache, sha256(name.encode()).hexdigest()[:16] + ".py")
                with open(target, "wb") as f:
                    f.write(r.content)
                _load_source(name, target)
        except Exception as e:
            import traceback
            traceback.print_exc()
