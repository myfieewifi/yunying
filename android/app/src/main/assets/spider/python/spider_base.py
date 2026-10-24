# 提供给用户 .py spider 的基础工具模块（与映匣 Runtime/PythonHost/base/spider.py 对齐），
# 二开时直接把映匣 base/spider.py 覆盖本文件即可。
class Runtime:
    def __init__(self):
        self.cache_file = None
        self.load_module = None
        self.proxy_url = ""

_runtime = Runtime()
