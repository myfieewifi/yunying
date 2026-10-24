package com.tvbox.yunying

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.blur
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.viewmodel.compose.viewModel
import coil.compose.AsyncImage
import com.tvbox.yunying.ui.theme.YunYingTheme
import dev.chrisbanes.haze.HazeState
import dev.chrisbanes.haze.haze
import dev.chrisbanes.haze.hazeChild

/**
 * 主界面：对齐映匣 SwiftUI 布局 ——
 *   顶部：Search + Settings 按钮
 *   左侧（TV/平板）/顶部Tab（手机）：站点选择
 *   中间：横向 shelf（首页推荐）
 *   底部：分类 tab 切换
 * 视觉：暗色 + 毛玻璃（GlassKit 对齐）+ 圆角卡片。
 */
class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            YunYingTheme {
                HomeScreen()
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(vm: MainViewModel = viewModel()) {
    val state by vm.ui.collectAsState()
    val haze = remember { HazeState() }
    var showInput by remember { mutableStateOf(false) }
    var urlInput by remember { mutableStateOf(state.configUrl) }

    Scaffold(
        containerColor = Color(0xFF0B0B0F),
        topBar = {
            TopAppBar(
                title = {
                    Text("云映", color = Color.White, fontWeight = FontWeight.Bold, fontSize = 22.sp)
                },
                actions = {
                    TextButton(onClick = { showInput = true }) {
                        Text("订阅", color = Color(0xFF2DD4BF))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = Color.Transparent),
                modifier = Modifier
                    .hazeChild(haze, style = androidx.compose.ui.graphics.TileMode.Clamp.let {
                        dev.chrisbanes.haze.HazeStyle(
                            backgroundColor = Color(0x990B0B0F),
                            blurRadius = 24.dp,
                        )
                    })
            )
        }
    ) { padding ->
        Box(
            Modifier
                .fillMaxSize()
                .background(
                    Brush.verticalGradient(
                        listOf(Color(0xFF151522), Color(0xFF0B0B0F))
                    )
                )
                .haze(haze)
                .padding(padding)
        ) {
            if (state.loading) {
                CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color(0xFF2DD4BF))
            } else if (state.config == null) {
                EmptyHint("点击右上角「订阅」导入 TVBox 配置") { showInput = true }
            } else {
                HomeContent(state)
            }

            state.error?.let {
                Snackbar(Modifier.align(Alignment.BottomCenter).padding(16.dp)) { Text(it) }
            }
        }
    }

    if (showInput) {
        AlertDialog(
            onDismissRequest = { showInput = false },
            title = { Text("导入订阅") },
            text = {
                OutlinedTextField(
                    value = urlInput,
                    onValueChange = { urlInput = it },
                    label = { Text("配置 URL（.json）") },
                    placeholder = { Text("https://example.com/config.json") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    showInput = false
                    vm.loadConfig(urlInput.trim())
                }) { Text("导入") }
            },
            dismissButton = { TextButton(onClick = { showInput = false }) { Text("取消") } }
        )
    }
}

@Composable
private fun EmptyHint(text: String, onClick: () -> Unit) {
    Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
        Text(text, color = Color.Gray)
        Spacer(Modifier.height(16.dp))
        Button(onClick = onClick, colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF2DD4BF))) {
            Text("立即导入", color = Color.Black)
        }
    }
}

@Composable
private fun HomeContent(state: HomeUiState) {
    val cfg = state.config ?: return
    Column(Modifier.fillMaxSize().padding(horizontal = 20.dp)) {
        // 站点选择条（映匣 Shelves 下拉站点）
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(cfg.sites.indices.toList()) { idx ->
                val site = cfg.sites[idx]
                val selected = idx == state.currentSiteIndex
                Surface(
                    color = if (selected) Color(0xFF2DD4BF) else Color(0xFF1E1E2A),
                    shape = RoundedCornerShape(20.dp),
                ) {
                    Text(
                        site.name,
                        color = if (selected) Color.Black else Color.White,
                        fontWeight = if (selected) FontWeight.Bold else FontWeight.Normal,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
            }
        }

        Spacer(Modifier.height(16.dp))

        // 首页推荐货架
        Text("最近更新", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(12.dp))
        LazyRow(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            items(state.shelf) { vod ->
                VodCard(vod)
            }
        }

        Spacer(Modifier.height(24.dp))

        // 分类
        if (state.categories.isNotEmpty()) {
            Text("分类", color = Color.White, fontSize = 20.sp, fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(8.dp))
            LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(state.categories) { c ->
                    Surface(color = Color(0xFF1E1E2A), shape = RoundedCornerShape(12.dp)) {
                        Text(c.type_name, color = Color.LightGray, modifier = Modifier.padding(horizontal = 14.dp, vertical = 6.dp))
                    }
                }
            }
        }
    }
}

@Composable
private fun VodCard(vod: Vod) {
    Column(
        Modifier
            .width(130.dp)
    ) {
        AsyncImage(
            model = vod.vod_pic,
            contentDescription = vod.vod_name,
            contentScale = ContentScale.Crop,
            modifier = Modifier
                .fillMaxWidth()
                .height(180.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Color(0xFF222233))
        )
        Spacer(Modifier.height(6.dp))
        Text(vod.vod_name, color = Color.White, maxLines = 1, fontSize = 13.sp, fontWeight = FontWeight.Medium)
        if (!vod.vod_remarks.isNullOrBlank()) {
            Text(vod.vod_remarks, color = Color(0xFF9999AA), maxLines = 1, fontSize = 11.sp)
        }
    }
}
