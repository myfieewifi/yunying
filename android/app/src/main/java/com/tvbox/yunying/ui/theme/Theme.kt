package com.tvbox.yunying.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** 映匣品牌色：深色背景 + teal 强调色（映匣官网 #2dd4bf） */
private val DarkColors = darkColorScheme(
    primary = Color(0xFF2DD4BF),
    secondary = Color(0xFF0A84FF),
    background = Color(0xFF0B0B0F),
    surface = Color(0xFF151522),
    onPrimary = Color.Black,
    onSecondary = Color.White,
    onBackground = Color.White,
    onSurface = Color.White,
)

@Composable
fun YunYingTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = DarkColors, content = content)
}
