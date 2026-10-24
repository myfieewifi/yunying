"""iOS / tvOS 内嵌模式下运行的 host.py 适配层。

iOS 上不能 fork 子进程，Swift 侧通过嵌入式 Python C API 直接在本进程里加载该脚本。
为了和 macOS 子进程模式协议一致，我们仍然接受 stdin 一行为一个 command、写 responses/<id>.json，
只是把 sys.stdin / sys.stdout 替换为 Swift 侧通过 Pipe 注入的临时文件路径（通过环境变量传入）。

环境变量：
  YX_REQUEST_JSON  : 首次请求的 request.json 路径（含 spider/ext/cache 等初始信息）
  YX_STDIN_FIFO    : Swift 写入命令的管道（或普通文件）路径
  YX_RESPONSE_DIR  : 写回响应的目录（等价于 cache/responses）
"""
import json
import os
import sys
import threading
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path[:0] = [HERE, os.path.join(HERE, 'site-packages')]

# 与 macOS 版复用同一份 host.py 主逻辑
import host as mac_host  # type: ignore


def run_inline():
    """iOS 入口：Swift 调用 PyRun_SimpleString("import host_ios; host_ios.run_inline()") 启动。"""
    req_path = os.environ.get('YX_REQUEST_JSON')
    if not req_path:
        print('YX_REQUEST_JSON not set', file=sys.stderr)
        sys.exit(2)
    with open(req_path, encoding='utf-8') as f:
        mac_host.request = json.load(f)
    mac_host.cache = mac_host.request['cache']
    mac_host.profile = mac_host.request.get('profile') or os.path.join(mac_host.cache, 'profile')
    os.makedirs(mac_host.profile, exist_ok=True)
    os.makedirs(os.path.join(mac_host.cache, 'responses'), exist_ok=True)
    os.chdir(mac_host.cache)

    try:
        mac_host.spider = mac_host.initialize()
    except Exception as e:
        mac_host.write_json(os.path.join(mac_host.cache, 'ready.json'), mac_host.envelope(e))
        return

    mac_host.write_json(os.path.join(mac_host.cache, 'ready.json'), {'ready': True})

    stdin_path = os.environ.get('YX_STDIN_FIFO')
    if not stdin_path:
        # 单次模式：直接响应第一次请求的 params 然后返回
        print(json.dumps(mac_host.call(mac_host.request.get('params') or {}), ensure_ascii=False), flush=True)
        return

    # 长驻模式：持续读 stdin 文件，逐行处理
    while True:
        try:
            with open(stdin_path, 'r', encoding='utf-8') as f:
                line = f.readline()
            if not line:
                threading.Event().wait(0.1)
                continue
            cmd = json.loads(line)
            rid = str(cmd.get('id', ''))
            if not rid:
                continue
            try:
                resp = mac_host.call(cmd.get('params') or {})
            except Exception as e:
                resp = mac_host.envelope(e)
            mac_host.write_json(os.path.join(mac_host.cache, 'responses', rid + '.json'), resp)
            # 用截断方式清空这一行，Swift 端靠 id 读 responses 文件即可
            with open(stdin_path, 'w', encoding='utf-8') as f:
                f.truncate(0)
        except Exception:
            traceback.print_exc()
            threading.Event().wait(0.5)


if __name__ == '__main__' or os.environ.get('YX_EMBEDDED'):
    # 嵌入式加载时没有 __name__ == '__main__'，靠环境变量触发
    run_inline()
