package com.tvbox.yunying

import android.app.Application
import android.content.Intent
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tvbox.yunying.player.PlayerActivity
import com.tvbox.yunying.spider.SpiderManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** 导航页签（仿腾讯视频底部导航） */
sealed class Screen {
    data object Home : Screen()
    data object Channel : Screen()
    data object Search : Screen()
    data object Mine : Screen()
    data class Detail(val vod: Vod) : Screen()
}

/** 选集分组：一条线路（vod_play_from 的一段） */
data class EpisodeGroup(val flag: String, val episodes: List<Episode>)
data class Episode(val name: String, val id: String)

data class HomeUiState(
    val configUrl: String = "",
    val config: TvBoxConfig? = null,
    val currentSiteIndex: Int = 0,
    val categories: List<Category> = emptyList(),
    val shelf: List<Vod> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    // 导航
    val screen: Screen = Screen.Home,
    // 频道页（分类内容分页）
    val currentCategoryTid: String? = null,
    val categoryItems: List<Vod> = emptyList(),
    val categoryPage: Int = 1,
    val categoryTotal: Int = 1,
    val categoryLoading: Boolean = false,
    // 详情页
    val detail: VodDetail? = null,
    val episodes: List<EpisodeGroup> = emptyList(),
    val detailLoading: Boolean = false,
    // 搜索
    val searchQuery: String = "",
    val searchResults: List<Vod> = emptyList(),
    val searching: Boolean = false,
    val searched: Boolean = false,
    // 播放历史（继续观看）
    val history: List<HistoryItem> = emptyList(),
)

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val _ui = MutableStateFlow(HomeUiState())
    val ui: StateFlow<HomeUiState> = _ui

    /** 详情页返回时回到的原页面 */
    private var returnScreen: Screen = Screen.Home

    init {
        SpiderManager.init(app)
        refreshHistory()
        viewModelScope.launch {
            val last = ConfigLoader.last(app)
            if (last != null) {
                SpiderManager.setGlobalJar(last.spider)
                _ui.value = _ui.value.copy(config = last)
                if (last.sites.isNotEmpty()) loadHome(0)
            }
        }
    }

    // ---- 导航 ----

    fun navigate(screen: Screen) {
        if (screen is Screen.Detail) returnScreen = _ui.value.screen
        _ui.value = _ui.value.copy(screen = screen)
        if (screen == Screen.Home) refreshHistory()
        when (screen) {
            is Screen.Detail -> openDetail(screen.vod)
            is Screen.Channel -> if (_ui.value.currentCategoryTid == null) selectCategory(_ui.value.categories.firstOrNull()?.type_id)
            else -> Unit
        }
    }

    /** 返回：详情 → 打开详情前的页面；频道/搜索 → 首页 */
    fun back(): Boolean {
        val s = _ui.value.screen
        when (s) {
            is Screen.Detail -> _ui.value = _ui.value.copy(screen = returnScreen, detail = null, episodes = emptyList())
            is Screen.Channel -> {
                _ui.value = _ui.value.copy(screen = Screen.Home)
                refreshHistory()
            }
            is Screen.Search -> {
                _ui.value = _ui.value.copy(screen = Screen.Home, searchResults = emptyList(), searched = false, searchQuery = "")
                refreshHistory()
            }
            else -> return false
        }
        return true
    }

    // ---- 订阅 ----

    fun loadConfig(url: String) {
        viewModelScope.launch {
            _ui.value = _ui.value.copy(loading = true, error = null)
            runCatching {
                val cfg = ConfigLoader.load(getApplication(), url)
                SpiderManager.clear()
                SpiderManager.setGlobalJar(cfg.spider)
                _ui.value = _ui.value.copy(
                    config = cfg, configUrl = url, currentSiteIndex = 0,
                    categories = emptyList(), shelf = emptyList(),
                    currentCategoryTid = null, categoryItems = emptyList(),
                    loading = false, screen = Screen.Home,
                )
                if (cfg.sites.isNotEmpty()) loadHome(0)
            }.onFailure {
                _ui.value = _ui.value.copy(loading = false, error = it.message ?: "加载失败")
            }
        }
    }

    fun selectSite(idx: Int) {
        _ui.value = _ui.value.copy(
            currentSiteIndex = idx,
            categories = emptyList(), shelf = emptyList(),
            currentCategoryTid = null, categoryItems = emptyList(),
        )
        loadHome(idx)
    }

    fun loadHome(siteIdx: Int) {
        val cfg = _ui.value.config ?: return
        if (siteIdx !in cfg.sites.indices) return
        viewModelScope.launch {
            _ui.value = _ui.value.copy(loading = true)
            runCatching {
                val site = cfg.sites[siteIdx]
                val spider = withContext(Dispatchers.IO) { SpiderManager.get(site) }
                val result = withContext(Dispatchers.IO) { spider.homeContent(true) }
                val cats = result.`class` ?: emptyList()
                _ui.value = _ui.value.copy(
                    categories = cats,
                    shelf = result.list ?: emptyList(),
                    loading = false,
                )
                if (_ui.value.screen is Screen.Channel && cats.isNotEmpty()) {
                    selectCategory(cats.first().type_id)
                }
            }.onFailure {
                _ui.value = _ui.value.copy(loading = false, error = it.message)
            }
        }
    }

    // ---- 频道（分类内容，分页加载） ----

    fun selectCategory(tid: String?) {
        if (tid == null) return
        _ui.value = _ui.value.copy(currentCategoryTid = tid, categoryItems = emptyList(), categoryPage = 1, categoryTotal = 1)
        loadCategoryPage(reset = true)
    }

    fun loadCategoryPage(reset: Boolean) {
        val cfg = _ui.value.config ?: return
        val tid = _ui.value.currentCategoryTid ?: return
        if (_ui.value.categoryLoading) return
        val page = if (reset) 1 else _ui.value.categoryPage + 1
        if (!reset && page > _ui.value.categoryTotal) return
        viewModelScope.launch {
            _ui.value = _ui.value.copy(categoryLoading = true)
            runCatching {
                val site = cfg.sites[_ui.value.currentSiteIndex]
                val spider = withContext(Dispatchers.IO) { SpiderManager.get(site) }
                val result = withContext(Dispatchers.IO) {
                    spider.categoryContent(tid, page.toString(), true, emptyMap())
                }
                val items = result.list ?: emptyList()
                _ui.value = _ui.value.copy(
                    categoryItems = if (reset) items else _ui.value.categoryItems + items,
                    categoryPage = page,
                    categoryTotal = if (result.pagecount <= 0) 1 else result.pagecount,
                    categoryLoading = false,
                )
            }.onFailure {
                _ui.value = _ui.value.copy(categoryLoading = false, error = it.message)
            }
        }
    }

    // ---- 详情 ----

    private fun openDetail(vod: Vod) {
        val cfg = _ui.value.config ?: return
        viewModelScope.launch {
            _ui.value = _ui.value.copy(detail = null, episodes = emptyList(), detailLoading = true)
            runCatching {
                val site = cfg.sites[_ui.value.currentSiteIndex]
                val spider = withContext(Dispatchers.IO) { SpiderManager.get(site) }
                val map = withContext(Dispatchers.IO) { spider.detailContent(listOf(vod.vod_id)) }
                val list = (map["list"] as? List<*>) ?: emptyList<Any>()
                val m = list.firstOrNull() as? Map<*, *> ?: map
                fun str(k: String): String? = (m[k] as? String)?.takeIf { it.isNotBlank() }
                val detail = VodDetail(
                    vod_id = str("vod_id") ?: vod.vod_id,
                    vod_name = str("vod_name") ?: vod.vod_name,
                    vod_pic = str("vod_pic") ?: vod.vod_pic,
                    vod_remarks = str("vod_remarks") ?: vod.vod_remarks,
                    vod_year = str("vod_year"),
                    vod_area = str("vod_area"),
                    vod_director = str("vod_director"),
                    vod_actor = str("vod_actor"),
                    vod_content = str("vod_content"),
                    vod_play_from = str("vod_play_from"),
                    vod_play_url = str("vod_play_url"),
                )
                _ui.value = _ui.value.copy(detail = detail, episodes = parseEpisodes(detail), detailLoading = false)
            }.onFailure {
                _ui.value = _ui.value.copy(detailLoading = false, error = it.message)
            }
        }
    }

    /** vod_play_from="线路1$$$线路2"；vod_play_url="第1集$1#第2集$2$$$..." */
    private fun parseEpisodes(d: VodDetail): List<EpisodeGroup> {
        val flags = (d.vod_play_from ?: "").split("$$$").map { it.trim() }.filter { it.isNotBlank() }
        val urls = (d.vod_play_url ?: "").split("$$$")
        if (flags.isEmpty() || urls.isEmpty()) return emptyList()
        return flags.mapIndexed { i, flag ->
            val body = urls.getOrNull(i).orEmpty()
            val eps = body.split('#').mapNotNull { seg ->
                val seg = seg.trim()
                if (seg.isBlank()) return@mapNotNull null
                val parts = seg.split('$')
                when {
                    parts.size >= 2 -> Episode(parts[0].trim(), parts[1].trim())
                    else -> Episode(seg, seg)
                }
            }
            EpisodeGroup(flag, eps)
        }.filter { it.episodes.isNotEmpty() }
    }

    // ---- 播放 ----

    fun playEpisode(flag: String, episode: Episode) {
        val cfg = _ui.value.config ?: return
        val detail = _ui.value.detail ?: return
        val group = _ui.value.episodes.firstOrNull { it.flag == flag }
        startPlayer(
            site = cfg.sites[_ui.value.currentSiteIndex],
            siteIndex = _ui.value.currentSiteIndex,
            vodId = detail.vod_id,
            vodName = detail.vod_name,
            vodPic = detail.vod_pic ?: "",
            flag = flag,
            episode = episode,
            episodes = group?.episodes ?: listOf(episode),
            position = 0L,
        )
    }

    /** 从播放历史直接续播（重新拉详情定位集数，再取播放地址） */
    fun resumeFromHistory(h: HistoryItem) {
        val cfg = _ui.value.config ?: return
        if (h.siteIndex !in cfg.sites.indices) {
            _ui.value = _ui.value.copy(error = "该历史对应的站点已不在当前订阅中")
            return
        }
        viewModelScope.launch {
            runCatching {
                val site = cfg.sites[h.siteIndex]
                val spider = withContext(Dispatchers.IO) { SpiderManager.get(site) }
                val map = withContext(Dispatchers.IO) { spider.detailContent(listOf(h.vodId)) }
                val list = (map["list"] as? List<*>) ?: emptyList<Any>()
                val m = list.firstOrNull() as? Map<*, *> ?: map
                fun str(k: String): String? = (m[k] as? String)?.takeIf { it.isNotBlank() }
                val detail = VodDetail(
                    vod_id = str("vod_id") ?: h.vodId,
                    vod_name = str("vod_name") ?: h.vodName,
                    vod_pic = str("vod_pic") ?: h.vodPic,
                    vod_remarks = str("vod_remarks"),
                    vod_year = str("vod_year"),
                    vod_area = str("vod_area"),
                    vod_director = str("vod_director"),
                    vod_actor = str("vod_actor"),
                    vod_content = str("vod_content"),
                    vod_play_from = str("vod_play_from"),
                    vod_play_url = str("vod_play_url"),
                )
                val groups = parseEpisodes(detail)
                val group = groups.firstOrNull { it.flag == h.flag } ?: groups.firstOrNull()
                    ?: throw IllegalStateException("未找到可播放的集数")
                val ep = group.episodes.firstOrNull { it.id == h.episodeId } ?: group.episodes.firstOrNull()
                    ?: throw IllegalStateException("未找到可播放的集数")
                startPlayer(
                    site = site,
                    siteIndex = h.siteIndex,
                    vodId = h.vodId,
                    vodName = detail.vod_name,
                    vodPic = detail.vod_pic ?: "",
                    flag = group.flag,
                    episode = ep,
                    episodes = group.episodes,
                    position = h.position,
                )
            }.onFailure {
                _ui.value = _ui.value.copy(error = it.message ?: "续播失败")
            }
        }
    }

    /** 解析播放地址并启动播放器（携带选集列表与续播位置） */
    private fun startPlayer(
        site: Site,
        siteIndex: Int,
        vodId: String,
        vodName: String,
        vodPic: String,
        flag: String,
        episode: Episode,
        episodes: List<Episode>,
        position: Long,
    ) {
        viewModelScope.launch {
            runCatching {
                val spider = withContext(Dispatchers.IO) { SpiderManager.get(site) }
                val map = withContext(Dispatchers.IO) { spider.playerContent(flag, episode.id, listOf(flag)) }
                @Suppress("UNCHECKED_CAST")
                val headers = parseHeaders(map["header"])
                val url = (map["url"] as? String).orEmpty()
                val playUrl = (map["playUrl"] as? String).orEmpty()
                val parse = (map["parse"] as? Number)?.toInt() ?: 0
                val target = url.takeIf { it.startsWith("http") || it.startsWith("rtmp") || it.startsWith("rtsp") }
                    ?: playUrl.takeIf { it.startsWith("http") }
                if (target.isNullOrBlank()) {
                    _ui.value = _ui.value.copy(
                        error = if (parse == 1) "该线路需要解析接口（暂不支持），请换线路或换源" else "取播放地址失败，请换线路或换源",
                    )
                    return@launch
                }
                val intent = Intent(getApplication(), PlayerActivity::class.java).apply {
                    putExtra(PlayerActivity.EXTRA_URL, target)
                    putExtra(PlayerActivity.EXTRA_TITLE, "${vodName}·${episode.name}")
                    putExtra(PlayerActivity.EXTRA_HEADERS, java.util.HashMap(headers))
                    putExtra(PlayerActivity.EXTRA_SITE_INDEX, siteIndex)
                    putExtra(PlayerActivity.EXTRA_VOD_ID, vodId)
                    putExtra(PlayerActivity.EXTRA_VOD_NAME, vodName)
                    putExtra(PlayerActivity.EXTRA_VOD_PIC, vodPic)
                    putExtra(PlayerActivity.EXTRA_FLAG, flag)
                    putExtra(PlayerActivity.EXTRA_EPISODE_ID, episode.id)
                    putExtra(PlayerActivity.EXTRA_EPISODES, com.google.gson.Gson().toJson(episodes))
                    putExtra(PlayerActivity.EXTRA_POSITION, position)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                getApplication<Application>().startActivity(intent)
            }.onFailure {
                _ui.value = _ui.value.copy(error = it.message ?: "播放失败")
            }
        }
    }

    // ---- 播放历史 ----

    fun refreshHistory() {
        _ui.value = _ui.value.copy(history = HistoryStore.load(getApplication()))
    }

    fun removeHistory(h: HistoryItem) {
        _ui.value = _ui.value.copy(history = HistoryStore.remove(getApplication(), h))
    }

    private fun parseHeaders(raw: Any?): Map<String, String> {
        val s = (raw as? String)?.trim().orEmpty()
        if (s.isBlank() || s == "{}") return emptyMap()
        return runCatching {
            val m = com.google.gson.Gson().fromJson(s, Map::class.java)
            m.entries.associate { (k, v) -> "${k}" to "${v}" }
        }.getOrDefault(emptyMap())
    }

    // ---- 搜索 ----

    fun updateSearchQuery(q: String) {
        _ui.value = _ui.value.copy(searchQuery = q)
    }

    fun search() {
        val cfg = _ui.value.config ?: return
        val wd = _ui.value.searchQuery.trim()
        if (wd.isEmpty()) return
        viewModelScope.launch {
            _ui.value = _ui.value.copy(searching = true, searched = false, searchResults = emptyList())
            runCatching {
                val site = cfg.sites[_ui.value.currentSiteIndex]
                val spider = withContext(Dispatchers.IO) { SpiderManager.get(site) }
                val result = withContext(Dispatchers.IO) { spider.searchContent(wd, false, "1") }
                _ui.value = _ui.value.copy(
                    searchResults = result.list ?: emptyList(),
                    searching = false, searched = true,
                )
            }.onFailure {
                _ui.value = _ui.value.copy(searching = false, searched = true, error = it.message)
            }
        }
    }

    fun dismissError() {
        _ui.value = _ui.value.copy(error = null)
    }
}
