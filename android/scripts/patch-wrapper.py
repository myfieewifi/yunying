"""给官方 wrapper-java 3.2.3 加 FishCloud 兼容桥接方法。

FishCloud 系 jar（摸鱼儿订阅）编译自混淆版 wrapper：lambda$setConsole$0 / lambda$setProperty$0
被改名为 a。宿主侧用官方 jar 时 dex 校验找不到 a(...) 会 VerifyError。
补丁：在两个类里各加一个 public static a(...)，字节码直接 invokestatic 原 lambda。
"""
import struct, zipfile, shutil, io, os

SRC_JAR = r'D:\yunying-cache\temp\wrapper-java.jar'
DST_JAR = r'D:\eclipse-workspace\yunying\android\app\libs\wrapper-java-fish-3.2.3.jar'


def parse_pool(data):
    count = struct.unpack_from('>H', data, 8)[0]
    entries = {}  # idx -> (tag, start, end)
    off = 10
    idx = 1
    while idx < count:
        tag = data[off]
        start = off
        if tag == 1:
            ln = struct.unpack_from('>H', data, off + 1)[0]
            off += 3 + ln
        elif tag in (7, 8, 16, 19, 20):
            off += 3
        elif tag == 15:
            off += 4
        elif tag in (3, 4, 9, 10, 11, 12, 17, 18):
            off += 5
        elif tag in (5, 6):
            off += 9
            idx += 1
        else:
            raise ValueError('tag %d @%d' % (tag, off))
        entries[idx] = (tag, start, off)
        idx += 1
    return count, entries, off  # off = pool_end


def utf8_of(data, entries, idx):
    tag, s, e = entries[idx]
    assert tag == 1
    return data[s + 3:e].decode('utf-8', 'replace')


def find_utf8(data, entries, text):
    for idx, (tag, s, e) in entries.items():
        if tag == 1 and utf8_of(data, entries, idx) == text:
            return idx
    raise KeyError(text)


def patch_class(data, lambda_name):
    count, entries, pool_end = parse_pool(data)
    idx_lambda = find_utf8(data, entries, lambda_name)
    # lambda 的描述符：从 method_info 反查
    off = pool_end
    off += 6  # access/this/super
    ifc = struct.unpack_from('>H', data, off)[0]
    off += 2 + ifc * 2

    def read_members(off):
        cnt = struct.unpack_from('>H', data, off)[0]
        off += 2
        out = []
        for _ in range(cnt):
            acc, name_idx, desc_idx = struct.unpack_from('>HHH', data, off)
            off += 6
            attr_cnt = struct.unpack_from('>H', data, off)[0]
            off += 2
            for _ in range(attr_cnt):
                alen = struct.unpack_from('>I', data, off + 2)[0]
                off += 6 + alen
            out.append((acc, name_idx, desc_idx))
        return off, out

    off, fields = read_members(off)
    methods_count_off = off  # methods_count u16 的位置
    methods_end, methods = read_members(off)
    lam = [m for m in methods if m[1] == idx_lambda]
    assert len(lam) == 1, 'lambda not found: %s' % lambda_name
    acc, name_idx, desc_idx = lam[0]
    assert acc & 0x0008, 'lambda is not static'
    desc = utf8_of(data, entries, desc_idx)
    n_params = desc.count(';') + desc.count('[') - desc.count(')[')  # 粗略
    # 参数个数：解析描述符括号内
    params_desc = desc[1:desc.index(')')]
    k = 0
    i = 0
    while i < len(params_desc):
        if params_desc[i] in 'JD':
            k += 1; i += 2
        elif params_desc[i] == '[':
            j = i
            while params_desc[j] == '[':
                j += 1
            k += 1
            i = j + 1 if params_desc[j] != 'L' else params_desc.index(';', j) + 1
        elif params_desc[i] == 'L':
            k += 1
            i = params_desc.index(';', i) + 1
        else:
            k += 1; i += 1

    idx_code = find_utf8(data, entries, 'Code')
    this_class = struct.unpack_from('>H', data, pool_end + 2)[0]

    # 追加常量：Utf8 "a"、NameAndType、Methodref
    utf8_a = struct.pack('>BH', 1, 1) + b'a'
    idx_a = count
    nat = struct.pack('>BHH', 12, idx_a, desc_idx)
    idx_nat = count + 1
    mref = struct.pack('>BHH', 10, this_class, idx_nat)
    idx_mref = count + 2
    new_pool = utf8_a + nat + mref
    new_count = count + 3

    # 桥接方法字节码：aload_0..aload_{k-1}, invokestatic, areturn
    code = bytes([0x2B + j for j in range(k)]) + b'\xb8' + struct.pack('>H', idx_mref) + b'\xb0'
    code_attr = struct.pack('>HH', 3, k) + struct.pack('>I', len(code)) + code + struct.pack('>HH', 0, 0)
    code_attr = struct.pack('>H', idx_code) + struct.pack('>I', len(code_attr)) + code_attr
    method_info = struct.pack('>HHHH', 0x0009, idx_a, desc_idx, 1) + code_attr

    old_mc = struct.unpack_from('>H', data, methods_count_off)[0]
    out = data[:8] + struct.pack('>H', new_count) + data[10:pool_end] + new_pool \
        + data[pool_end:methods_count_off] + struct.pack('>H', old_mc + 1) + data[methods_count_off + 2:methods_end] \
        + method_info + data[methods_end:]
    return out, desc, k


def main():
    os.makedirs(os.path.dirname(DST_JAR), exist_ok=True)
    zin = zipfile.ZipFile(SRC_JAR)
    if os.path.exists(DST_JAR):
        os.remove(DST_JAR)
    zout = zipfile.ZipFile(DST_JAR, 'w', zipfile.ZIP_DEFLATED)
    patches = {
        'com/whl/quickjs/wrapper/QuickJSContext.class': 'lambda$setConsole$0',
        'com/whl/quickjs/wrapper/QuickJSObject.class': 'lambda$setProperty$0',
    }
    for n in zin.namelist():
        data = zin.read(n)
        if n in patches:
            data, desc, k = patch_class(data, patches[n])
            print('patched %s: a%s (was %s)' % (n, desc, patches[n]))
        zout.writestr(n, data)
    zout.close()
    print('written:', DST_JAR, os.path.getsize(DST_JAR))

    # 回读验证
    z = zipfile.ZipFile(DST_JAR)
    import sys
    sys.path.insert(0, r'C:\Users\Administrator\AppData\Local\Temp\opencode')
    from class_parse import parse_class_methods
    for n in patches:
        methods, fields = parse_class_methods(z.read(n))
        a = [(d, m) for m, d in methods if m == 'a']
        print('verify', n, '->', a)
        assert a, 'bridge method missing!'


main()
