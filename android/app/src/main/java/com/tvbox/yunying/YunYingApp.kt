package com.tvbox.yunying

import android.app.Application
import com.chaquo.python.Python
import com.chaquo.python.android.AndroidPlatform

/**
 * 云映 安卓端主 Application。
 * - 初始化 Chaquopy（Android 上的 Python 解释器），用于跑 .py 爬虫；
 * - 初始化 QuickJS（JSEngine 单例），用于跑 .js / .js.md (drpy) 爬虫；
 * - 注册全局异常处理，防止崩溃直接退出。
 */
class YunYingApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this

        // 启动 Python 运行时（Chaquopy 自带，第一次 start 较慢，放 Application）
        if (!Python.isStarted()) {
            Python.start(AndroidPlatform(this))
        }
    }

    companion object {
        lateinit var instance: YunYingApp
            private set
    }
}
