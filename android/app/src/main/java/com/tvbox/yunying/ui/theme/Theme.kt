package com.tvbox.yunying.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * 云映主题：仿腾讯视频视觉 ——
 *   深色底（#0B0B0F）+ 腾讯蓝强调（#3D7EFF，按钮/选中态）+ 白色主文本。
 */
object YunYingColors {
    val Background = Color(0xFF0B0B0F)
    val Surface = Color(0xFF14141C)
    val SurfaceHigh = Color(0xFF1E1E2A)
    val Accent = Color(0xFF3D7EFF)
    val AccentDark = Color(0xFF2E5BFF)
    val AccentLight = Color(0xFF5AA0FF)
    val Gold = Color(0xFFFFB03A)          // VIP/评分点缀（腾讯视频金）
    val TextPrimary = Color.White
    val TextSecondary = Color(0xFF9A9AAC)
    val TextTertiary = Color(0xFF66667A)
}

private val DarkColors = darkColorScheme(
    primary = YunYingColors.Accent,
    secondary = YunYingColors.AccentLight,
    background = YunYingColors.Background,
    surface = YunYingColors.Surface,
    onPrimary = Color.White,
    onSecondary = Color.White,
    onBackground = YunYingColors.TextPrimary,
    onSurface = YunYingColors.TextPrimary,
)

@Composable
fun YunYingTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, content = content)
}
