package com.tvbox.yunying

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.tvbox.yunying.spider.SpiderManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

data class HomeUiState(
    val configUrl: String = "",
    val config: TvBoxConfig? = null,
    val currentSiteIndex: Int = 0,
    val categories: List<Category> = emptyList(),
    val shelf: List<Vod> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
)

class MainViewModel(app: Application) : AndroidViewModel(app) {

    private val _ui = MutableStateFlow(HomeUiState())
    val ui: StateFlow<HomeUiState> = _ui

    init {
        SpiderManager.init(app)
        viewModelScope.launch {
            val last = ConfigLoader.last(app)
            if (last != null) {
                _ui.value = _ui.value.copy(config = last)
                if (last.sites.isNotEmpty()) loadHome(0)
            }
        }
    }

    fun loadConfig(url: String) {
        viewModelScope.launch {
            _ui.value = _ui.value.copy(loading = true, error = null)
            runCatching {
                val cfg = ConfigLoader.load(getApplication(), url)
                _ui.value = _ui.value.copy(config = cfg, configUrl = url, currentSiteIndex = 0, loading = false)
                if (cfg.sites.isNotEmpty()) loadHome(0)
            }.onFailure {
                _ui.value = _ui.value.copy(loading = false, error = it.message ?: "加载失败")
            }
        }
    }

    fun selectSite(idx: Int) {
        _ui.value = _ui.value.copy(currentSiteIndex = idx)
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
                _ui.value = _ui.value.copy(
                    categories = result.`class` ?: emptyList(),
                    shelf = result.list ?: emptyList(),
                    loading = false,
                )
            }.onFailure {
                _ui.value = _ui.value.copy(loading = false, error = it.message)
            }
        }
    }
}
