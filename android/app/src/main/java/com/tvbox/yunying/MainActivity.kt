package com.tvbox.yunying

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.grid.rememberLazyGridState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tv
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Tv
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.app.ActivityCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.tvbox.yunying.ui.theme.YunYingColors
import com.tvbox.yunying.ui.theme.YunYingTheme

/**
 * 主界面：仿腾讯视频 APP ——
 *   底部导航：首页 / 频道 / 搜索 / 我的
 *   首页：顶部 logo+搜索+订阅；站点源切换条；推荐货架；分类入口
 *   频道：分类 chips + 海报网格（滚动加载下一页）
 *   详情：大图背景 + 蓝色渐变播放按钮 + 线路/选集
 * 视觉：深色底 + 腾讯蓝（#3D7EFF）。
 */
class MainActivity : ComponentActivity() {

    private var pendingLegacyPermission = false

    private val legacyPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestStoragePermission()
        setContent {
            YunYingTheme {
                HomeScreen()
            }
        }
    }

    /** 文件读取/编辑权限：在线 jar 包与订阅配置需要落盘手机存储（仅首次启动自动弹一次） */
    private fun requestStoragePermission() {
        val prefs = getSharedPreferences("yunying", Context.MODE_PRIVATE)
        if (prefs.getBoolean("storage_asked", false)) return
        prefs.edit().putBoolean("storage_asked", true).apply()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                runCatching {
                    startActivity(
                        android.content.Intent(
                            android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                            Uri.parse("package:$packageName"),
                        )
                    )
                }.onFailure {
                    runCatching {
                        startActivity(android.content.Intent(android.provider.Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
                    }
                }
            }
        } else {
            val perms = arrayOf(
                Manifest.permission.READ_EXTERNAL_STORAGE,
                Manifest.permission.WRITE_EXTERNAL_STORAGE,
            )
            val granted = perms.all {
                ActivityCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
            if (!granted) {
                pendingLegacyPermission = true
                legacyPermissionLauncher.launch(perms)
            }
        }
    }

    fun hasStoragePermission(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) Environment.isExternalStorageManager()
        else ActivityCompat.checkSelfPermission(this, Manifest.permission.WRITE_EXTERNAL_STORAGE) ==
            PackageManager.PERMISSION_GRANTED
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: MainViewModel = viewModel()) {
    val state by vm.ui.collectAsState()
    var showInput by remember { mutableStateOf(false) }
    var urlInput by remember { mutableStateOf(state.configUrl) }

    // 返回键：详情→频道→首页
    BackHandler(enabled = state.screen !is Screen.Home) { vm.back() }

    Scaffold(
        containerColor = YunYingColors.Background,
        bottomBar = {
            if (state.screen !is Screen.Detail) {
                YunYingBottomBar(state.screen) { vm.navigate(it) }
            }
        },
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(listOf(Color(0xFF141422), YunYingColors.Background))
                )
                .padding(padding)
        ) {
            when (val s = state.screen) {
                is Screen.Home -> HomePage(vm, state, onSubscribe = { showInput = true })
                is Screen.Channel -> ChannelPage(vm, state)
                is Screen.Search -> SearchPage(vm, state)
                is Screen.Mine -> MinePage(vm, state, onSubscribe = { showInput = true })
                is Screen.Detail -> DetailPage(vm, state, s.vod)
            }

            if (state.loading || state.detailLoading) {
                CircularProgressIndicator(
                    Modifier.align(Alignment.Center),
                    color = YunYingColors.Accent,
                )
            }
            state.error?.let { msg ->
                Snackbar(
                    Modifier.align(Alignment.BottomCenter).padding(16.dp),
                    containerColor = Color(0xFF2A2A38),
                    contentColor = Color.White,
                    action = {
                        TextButton(onClick = { vm.dismissError() }) { Text("知道了", color = YunYingColors.Accent) }
                    },
                ) { Text(msg, maxLines = 3) }
            }
        }
    }

    if (showInput) {
        AlertDialog(
            onDismissRequest = { showInput = false },
            containerColor = YunYingColors.SurfaceHigh,
            title = { Text("导入订阅", color = Color.White) },
            text = {
                OutlinedTextField(
                    value = urlInput,
                    onValueChange = { urlInput = it },
                    label = { Text("配置 URL（.json）", color = YunYingColors.TextSecondary) },
                    placeholder = { Text("https://example.com/config.json", color = YunYingColors.TextTertiary) },
                    singleLine = true,
                    colors = OutlinedTextFieldDefaults.colors(
                        focusedBorderColor = YunYingColors.Accent,
                        cursorColor = YunYingColors.Accent,
                        focusedTextColor = Color.White,
                        unfocusedTextColor = Color.White,
                    ),
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                Button(
                    onClick = { showInput = false; vm.loadConfig(urlInput.trim()) },
                    colors = ButtonDefaults.buttonColors(containerColor = YunYingColors.Accent),
                ) { Text("导入", color = Color.White) }
            },
            dismissButton = {
                TextButton(onClick = { showInput = false }) { Text("取消", color = YunYingColors.TextSecondary) }
            }
        )
    }
}

// ---- 底部导航（腾讯视频式四页签） ----

@Composable
private fun YunYingBottomBar(current: Screen, onSelect: (Screen) -> Unit) {
    NavigationBar(containerColor = Color(0xFF12121A)) {
        val items = listOf(
            Triple(Screen.Home as Screen, "首页", Icons.Filled.Home to Icons.Outlined.Home),
            Triple(Screen.Channel as Screen, "频道", Icons.Filled.Tv to Icons.Outlined.Tv),
            Triple(Screen.Search as Screen, "搜索", Icons.Filled.Search to Icons.Outlined.Search),
            Triple(Screen.Mine as Screen, "我的", Icons.Filled.Person to Icons.Outlined.Person),
        )
        items.forEach { (screen, label, icons) ->
            val selected = current::class == screen::class
            NavigationBarItem(
                selected = selected,
                onClick = { onSelect(screen) },
                icon = { Icon(if (selected) icons.first else icons.second, contentDescription = label) },
                label = { Text(label) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = YunYingColors.Accent,
                    selectedTextColor = YunYingColors.Accent,
                    unselectedIconColor = YunYingColors.TextSecondary,
                    unselectedTextColor = YunYingColors.TextSecondary,
                    indicatorColor = YunYingColors.Accent.copy(alpha = 0.15f),
                ),
            )
        }
    }
}

// ---- 首页 ----

@Composable
private fun HomePage(vm: MainViewModel, state: HomeUiState, onSubscribe: () -> Unit) {
    val cfg = state.config
    Column(Modifier.fillMaxSize()) {
        // 顶栏：logo + 搜索 + 订阅
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text("云映", color = Color.White, fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text("VIDEO", color = YunYingColors.Accent, fontSize = 12.sp, fontWeight = FontWeight.Bold,
                 modifier = Modifier.padding(start = 4.dp).align(Alignment.Bottom))
            Spacer(Modifier.weight(1f))
            IconButton(onClick = { vm.navigate(Screen.Search) }) {
                Icon(Icons.Filled.Search, "搜索", tint = Color.White)
            }
            IconButton(onClick = onSubscribe) {
                Icon(Icons.Filled.MoreVert, "订阅", tint = Color.White)
            }
        }

        if (cfg == null) {
            EmptyHint("导入 TVBox 订阅，开启追剧之旅", onSubscribe)
            return
        }

        // 站点源切换条（腾讯视频频道条样式）
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(horizontal = 20.dp),
        ) {
            items(cfg.sites.indices.toList()) { idx ->
                val site = cfg.sites[idx]
                val selected = idx == state.currentSiteIndex
                Surface(
                    color = if (selected) YunYingColors.Accent else YunYingColors.SurfaceHigh,
                    shape = RoundedCornerShape(18.dp),
                ) {
                    Text(
                        site.name,
                        color = if (selected) Color.White else YunYingColors.TextSecondary,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                        modifier = Modifier
                            .clickable { vm.selectSite(idx) }
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        LazyColumn(Modifier.fillMaxSize()) {
            // 推荐货架
            if (state.shelf.isNotEmpty()) {
                item {
                    SectionHeader("为你推荐")
                    Spacer(Modifier.height(10.dp))
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        contentPadding = PaddingValues(horizontal = 20.dp),
                    ) {
                        items(state.shelf) { vod -> VodCard(vod) { vm.navigate(Screen.Detail(vod)) } }
                    }
                }
            }
            // 分类快捷入口
            if (state.categories.isNotEmpty()) {
                item {
                    Spacer(Modifier.height(22.dp))
                    SectionHeader("分类")
                    Spacer(Modifier.height(10.dp))
                    LazyRow(
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                        contentPadding = PaddingValues(horizontal = 20.dp),
                    ) {
                        items(state.categories) { c ->
                            Surface(
                                color = YunYingColors.SurfaceHigh,
                                shape = RoundedCornerShape(10.dp),
                            ) {
                                Text(
                                    c.type_name,
                                    color = YunYingColors.TextSecondary,
                                    modifier = Modifier
                                        .clickable {
                                            vm.selectCategory(c.type_id)
                                            vm.navigate(Screen.Channel)
                                        }
                                        .padding(horizontal = 14.dp, vertical = 8.dp),
                                )
                            }
                        }
                    }
                }
            }
            // 全部推荐网格
            if (state.shelf.isNotEmpty()) {
                item {
                    Spacer(Modifier.height(22.dp))
                    SectionHeader("猜你喜欢")
                }
                item {
                    Grid(state.shelf) { vod -> vm.navigate(Screen.Detail(vod)) }
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }
}

// ---- 频道页（分类内容 + 无限加载） ----

@Composable
private fun ChannelPage(vm: MainViewModel, state: HomeUiState) {
    Column(Modifier.fillMaxSize()) {
        Text(
            "频道",
            color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp),
        )
        // 分类 chips
        LazyRow(
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            contentPadding = PaddingValues(horizontal = 20.dp),
        ) {
            items(state.categories) { c ->
                val selected = c.type_id == state.currentCategoryTid
                Surface(
                    color = if (selected) YunYingColors.Accent else YunYingColors.SurfaceHigh,
                    shape = RoundedCornerShape(18.dp),
                ) {
                    Text(
                        c.type_name,
                        color = if (selected) Color.White else YunYingColors.TextSecondary,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                        modifier = Modifier
                            .clickable { vm.selectCategory(c.type_id) }
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            }
        }
        Spacer(Modifier.height(12.dp))
        val gridState = rememberLazyGridState()
        // 滚动到尾部自动加载下一页
        LaunchedEffect(gridState, state.currentCategoryTid) {
            snapshotFlow { gridState.layoutInfo.visibleItemsInfo.lastOrNull()?.index }
                .collect { last ->
                    if (last != null && last >= state.categoryItems.size - 6 && state.categoryItems.isNotEmpty()) {
                        vm.loadCategoryPage(reset = false)
                    }
                }
        }
        if (state.categoryItems.isEmpty() && !state.categoryLoading) {
            EmptyHint("该分类暂无内容")
        } else {
            LazyVerticalGrid(
                state = gridState,
                columns = GridCells.Fixed(3),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
                modifier = Modifier.fillMaxSize(),
            ) {
                items(state.categoryItems, key = { "${it.vod_id}_${it.vod_name}" }) { vod ->
                    VodCard(vod) { vm.navigate(Screen.Detail(vod)) }
                }
                if (state.categoryLoading) {
                    item(span = { androidx.compose.foundation.lazy.grid.GridItemSpan(3) }) {
                        Box(Modifier.fillMaxWidth().padding(12.dp), Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(22.dp), color = YunYingColors.Accent, strokeWidth = 2.dp)
                        }
                    }
                }
            }
        }
    }
}

// ---- 搜索页 ----

@Composable
private fun SearchPage(vm: MainViewModel, state: HomeUiState) {
    Column(Modifier.fillMaxSize()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            OutlinedTextField(
                value = state.searchQuery,
                onValueChange = { vm.updateSearchQuery(it) },
                placeholder = { Text("搜索影片 / 演员", color = YunYingColors.TextTertiary) },
                singleLine = true,
                shape = RoundedCornerShape(22.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = YunYingColors.Accent,
                    unfocusedBorderColor = Color(0xFF2A2A38),
                    cursorColor = YunYingColors.Accent,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                ),
                modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(10.dp))
            Button(
                onClick = { vm.search() },
                enabled = !state.searching && state.searchQuery.isNotBlank(),
                colors = ButtonDefaults.buttonColors(containerColor = YunYingColors.Accent),
                shape = RoundedCornerShape(22.dp),
            ) { Text("搜索", color = Color.White) }
        }
        if (state.searching) {
            Box(Modifier.fillMaxSize(), Alignment.Center) {
                CircularProgressIndicator(color = YunYingColors.Accent)
            }
        } else if (state.searched && state.searchResults.isEmpty()) {
            EmptyHint("没有找到「${state.searchQuery}」相关内容")
        } else if (state.searchResults.isNotEmpty()) {
            LazyVerticalGrid(
                columns = GridCells.Fixed(3),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp),
            ) {
                items(state.searchResults, key = { "${it.vod_id}_${it.vod_name}" }) { vod ->
                    VodCard(vod) { vm.navigate(Screen.Detail(vod)) }
                }
            }
        } else {
            EmptyHint("输入关键词，在当前片源中搜索")
        }
    }
}

// ---- 我的 ----

@Composable
private fun MinePage(vm: MainViewModel, state: HomeUiState, onSubscribe: () -> Unit) {
    val activity = androidx.compose.ui.platform.LocalContext.current as? MainActivity
    var storageGranted by remember { mutableStateOf(activity?.hasStoragePermission() ?: false) }
    // 从系统设置页授权返回后自动刷新状态
    androidx.compose.runtime.DisposableEffect(activity) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, e ->
            if (e == androidx.lifecycle.Lifecycle.Event.ON_RESUME) {
                storageGranted = activity?.hasStoragePermission() ?: false
            }
        }
        activity?.lifecycle?.addObserver(observer)
        onDispose { activity?.lifecycle?.removeObserver(observer) }
    }
    Column(
        Modifier.fillMaxSize().padding(horizontal = 20.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text(
            "我的",
            color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold,
            modifier = Modifier.padding(vertical = 12.dp),
        )
        // 订阅
        Surface(color = YunYingColors.Surface, shape = RoundedCornerShape(14.dp)) {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Text("订阅源", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text(
                    state.configUrl.ifBlank { "未导入（使用默认缓存配置）" },
                    color = YunYingColors.TextSecondary, fontSize = 13.sp, maxLines = 2, overflow = TextOverflow.Ellipsis,
                )
                Spacer(Modifier.height(10.dp))
                Button(
                    onClick = onSubscribe,
                    colors = ButtonDefaults.buttonColors(containerColor = YunYingColors.Accent),
                    shape = RoundedCornerShape(20.dp),
                ) { Text(if (state.configUrl.isBlank()) "导入订阅" else "更换订阅", color = Color.White) }
            }
        }
        // 存储权限
        Surface(color = YunYingColors.Surface, shape = RoundedCornerShape(14.dp)) {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Text("存储权限", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text(
                    if (storageGranted) "已授权：在线 jar 包与配置可保存到手机存储"
                    else "未授权：在线 jar 包将无法保存，请开启“所有文件访问”",
                    color = if (storageGranted) YunYingColors.TextSecondary else YunYingColors.Gold,
                    fontSize = 13.sp,
                )
                if (!storageGranted) {
                    Spacer(Modifier.height(10.dp))
                    Button(
                        onClick = { activity?.requestStoragePermission() },
                        colors = ButtonDefaults.buttonColors(containerColor = YunYingColors.Gold),
                        shape = RoundedCornerShape(20.dp),
                    ) { Text("去授权", color = Color.Black) }
                }
            }
        }
        // 关于
        Surface(color = YunYingColors.Surface, shape = RoundedCornerShape(14.dp)) {
            Column(Modifier.fillMaxWidth().padding(16.dp)) {
                Text("关于", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Text("云映 1.0.0", color = YunYingColors.TextSecondary, fontSize = 13.sp)
                Text("© 2026 云映", color = YunYingColors.TextTertiary, fontSize = 12.sp)
            }
        }
    }
}

// ---- 详情页（腾讯视频式：大图 + 播放按钮 + 线路选集） ----

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DetailPage(vm: MainViewModel, state: HomeUiState, vod: Vod) {
    val detail = state.detail
    var expanded by remember { mutableStateOf(false) }
    var currentFlag by remember(detail?.vod_id) { mutableStateOf(state.episodes.firstOrNull()?.flag) }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.fillMaxWidth().height(280.dp)) {
                AsyncImage(
                    model = detail?.vod_pic ?: vod.vod_pic,
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
                // 底部渐隐
                Box(
                    Modifier.fillMaxSize().background(
                        Brush.verticalGradient(
                            0f to Color.Transparent,
                            1f to YunYingColors.Background,
                        )
                    )
                )
                TopAppBar(
                    title = {},
                    navigationIcon = {
                        IconButton(onClick = { vm.back() }) {
                            Icon(Icons.Filled.ArrowBack, "返回", tint = Color.White)
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                )
            }

            detail ?: run {
                Box(Modifier.fillMaxSize(), Alignment.Center) { Text("加载中…", color = YunYingColors.TextSecondary) }
                return@DetailPage
            }

            Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
                Text(detail.vod_name, color = Color.White, fontSize = 22.sp, fontWeight = FontWeight.Bold)
                Spacer(Modifier.height(6.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    listOfNotNull(
                        detail.vod_year?.takeIf { it.isNotBlank() },
                        detail.vod_area?.takeIf { it.isNotBlank() },
                        detail.vod_remarks?.takeIf { it.isNotBlank() },
                    ).forEach { tag ->
                        Surface(color = YunYingColors.SurfaceHigh, shape = RoundedCornerShape(6.dp)) {
                            Text(tag, color = YunYingColors.TextSecondary, fontSize = 11.sp,
                                 modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp))
                        }
                    }
                }
                Spacer(Modifier.height(14.dp))
                // 播放按钮（腾讯蓝渐变）
                val firstEp = state.episodes.firstOrNull()?.episodes?.firstOrNull()
                if (firstEp != null) {
                    Button(
                        onClick = { vm.playEpisode(state.episodes.first().flag, firstEp) },
                        shape = RoundedCornerShape(24.dp),
                        colors = ButtonDefaults.buttonColors(containerColor = YunYingColors.Accent),
                        contentPadding = PaddingValues(horizontal = 34.dp, vertical = 12.dp),
                    ) {
                        Icon(Icons.Filled.PlayArrow, null, tint = Color.White)
                        Spacer(Modifier.width(6.dp))
                        Text("立即播放", color = Color.White, fontSize = 16.sp, fontWeight = FontWeight.Bold)
                    }
                }
                Spacer(Modifier.height(14.dp))
                // 简介
                detail.vod_content?.takeIf { it.isNotBlank() }?.let { c ->
                    Text(
                        c.replace(Regex("<[^>]+>"), "").trim(),
                        color = YunYingColors.TextSecondary,
                        fontSize = 13.sp, lineHeight = 20.sp,
                        maxLines = if (expanded) Int.MAX_VALUE else 3,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.clickable { expanded = !expanded },
                    )
                    Spacer(Modifier.height(12.dp))
                }
                // 线路 + 选集
                if (state.episodes.isNotEmpty()) {
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        state.episodes.forEach { g ->
                            val selected = g.flag == currentFlag
                            Surface(
                                color = if (selected) YunYingColors.Accent else YunYingColors.SurfaceHigh,
                                shape = RoundedCornerShape(16.dp),
                            ) {
                                Text(
                                    g.flag,
                                    color = if (selected) Color.White else YunYingColors.TextSecondary,
                                    fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                                    modifier = Modifier
                                        .clickable { currentFlag = g.flag }
                                        .padding(horizontal = 14.dp, vertical = 7.dp),
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    val group = state.episodes.firstOrNull { it.flag == currentFlag } ?: state.episodes.first()
                    LazyVerticalGrid(
                        columns = GridCells.Fixed(4),
                        horizontalArrangement = Arrangement.spacedBy(8.dp),
                        verticalArrangement = Arrangement.spacedBy(8.dp),
                        modifier = Modifier.fillMaxSize(),
                        contentPadding = PaddingValues(bottom = 24.dp),
                    ) {
                        items(group.episodes) { ep ->
                            Surface(
                                color = YunYingColors.SurfaceHigh,
                                shape = RoundedCornerShape(8.dp),
                                modifier = Modifier.clickable { vm.playEpisode(group.flag, ep) },
                            ) {
                                Box(Modifier.fillMaxWidth().padding(vertical = 9.dp), Alignment.Center) {
                                    Text(
                                        ep.name,
                                        color = Color.White, fontSize = 12.sp,
                                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        modifier = Modifier.padding(horizontal = 6.dp),
                                    )
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ---- 通用组件 ----

@Composable
private fun SectionHeader(title: String) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.width(4.dp).height(16.dp)
                .background(YunYingColors.Accent, RoundedCornerShape(2.dp))
        )
        Spacer(Modifier.width(8.dp))
        Text(title, color = Color.White, fontSize = 18.sp, fontWeight = FontWeight.Bold)
    }
}

@Composable
private fun VodCard(vod: Vod, onClick: () -> Unit) {
    Column(Modifier.width(112.dp).clickable(onClick = onClick)) {
        AsyncImage(
            model = vod.vod_pic,
            contentDescription = vod.vod_name,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .fillMaxWidth()
                .height(158.dp)
                .clip(RoundedCornerShape(10.dp))
                .background(YunYingColors.SurfaceHigh)
        )
        Spacer(Modifier.height(6.dp))
        Text(
            vod.vod_name, color = Color.White,
            maxLines = 1, overflow = TextOverflow.Ellipsis,
            fontSize = 13.sp, fontWeight = FontWeight.Medium,
        )
        if (!vod.vod_remarks.isNullOrBlank()) {
            Text(vod.vod_remarks, color = YunYingColors.TextTertiary, maxLines = 1, fontSize = 11.sp)
        }
    }
}

/** 简易 3 列网格（首页用，避免嵌套滚动冲突） */
@Composable
private fun Grid(items: List<Vod>, onClick: (Vod) -> Unit) {
    val rows = items.chunked(3)
    Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        for (row in rows) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                for (vod in row) { VodCard(vod) { onClick(vod) } }
            }
        }
    }
}

@Composable
private fun EmptyHint(text: String, onClick: (() -> Unit)? = null) {
    Column(
        Modifier.fillMaxSize().padding(40.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(text, color = YunYingColors.TextSecondary, fontSize = 15.sp)
        if (onClick != null) {
            Spacer(Modifier.height(18.dp))
            Button(
                onClick = onClick,
                colors = ButtonDefaults.buttonColors(containerColor = YunYingColors.Accent),
                shape = RoundedCornerShape(22.dp),
                contentPadding = PaddingValues(horizontal = 28.dp, vertical = 10.dp),
            ) { Text("立即导入", color = Color.White) }
        }
    }
}
