package com.tvbox.yunying

import android.content.Context
import com.google.gson.Gson
import com.google.gson.reflect.TypeToken

/**
 * 单条播放历史（用于"继续观看"与续播）。
 * siteIndex 对应当前订阅配置里的站点下标；换订阅后站点可能对不上，续播时会校验。
 */
data class HistoryItem(
    val siteIndex: Int = 0,
    val vodId: String = "",
    val vodName: String = "",
    val vodPic: String = "",
    val flag: String = "",
    val episodeId: String = "",
    val episodeName: String = "",
    val position: Long = 0L,
    val duration: Long = 0L,
    val updatedAt: Long = 0L,
) {
    /** 观看进度 0f..1f（时长未知返回 0f） */
    fun progress(): Float =
        if (duration > 0) (position.toFloat() / duration).coerceIn(0f, 1f) else 0f
}

/**
 * 播放历史存储：SharedPreferences + Gson JSON，最多保留 50 条。
 * 同一 site+vod 去重置顶（看过的剧永远在最前面）。
 */
object HistoryStore {
    private const val PREF = "yunying"
    private const val KEY = "yunying_play_history"
    private const val MAX_ENTRIES = 50

    private val gson = Gson()
    private val type = object : TypeToken<MutableList<HistoryItem>>() {}.type

    fun load(context: Context): List<HistoryItem> = runCatching {
        val json = prefs(context).getString(KEY, null) ?: return emptyList()
        val list: MutableList<HistoryItem>? = gson.fromJson(json, type)
        list ?: emptyList()
    }.getOrDefault(emptyList())

    /** 记录/更新一条历史（同 site+vod 去重置顶），返回最新列表 */
    fun record(context: Context, item: HistoryItem): List<HistoryItem> {
        val list = load(context).toMutableList()
        list.removeAll { it.siteIndex == item.siteIndex && it.vodId == item.vodId }
        list.add(0, item)
        while (list.size > MAX_ENTRIES) list.removeAt(list.size - 1)
        save(context, list)
        return list
    }

    /** 删除一条历史，返回最新列表 */
    fun remove(context: Context, item: HistoryItem): List<HistoryItem> {
        val list = load(context).toMutableList()
        list.removeAll { it.siteIndex == item.siteIndex && it.vodId == item.vodId }
        save(context, list)
        return list
    }

    fun clear(context: Context) {
        prefs(context).edit().remove(KEY).apply()
    }

    private fun save(context: Context, list: List<HistoryItem>) {
        prefs(context).edit().putString(KEY, gson.toJson(list)).apply()
    }

    private fun prefs(context: Context) =
        context.getSharedPreferences(PREF, Context.MODE_PRIVATE)
}
