package com.frontierwire.core

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

/** The site's colours: ink on paper, one blue signal, green and red for yes/no. */
data class WireColors(val muted: Color, val line: Color, val yes: Color, val no: Color, val warn: Color)

private val LightWire = WireColors(muted = Color(0xFF5B6B7C), line = Color(0xFFD6DDE5), yes = Color(0xFF12805C), no = Color(0xFFC2412D), warn = Color(0xFFC27C00))
private val DarkWire = WireColors(muted = Color(0xFF8EA0B5), line = Color(0xFF22364F), yes = Color(0xFF3CCF97), no = Color(0xFFFF7A63), warn = Color(0xFFE9A83A))

val LocalWire = staticCompositionLocalOf { LightWire }

private val Light = lightColorScheme(
    primary = Color(0xFF2F54EB), onPrimary = Color.White,
    background = Color(0xFFEEF1F4), onBackground = Color(0xFF0D1B2A),
    surface = Color(0xFFFFFFFF), onSurface = Color(0xFF0D1B2A),
    surfaceVariant = Color(0xFFE4E9EF), onSurfaceVariant = Color(0xFF2C3A4B),
    surfaceContainer = Color(0xFFFFFFFF), surfaceContainerHigh = Color(0xFFF5F7FA),
    outline = Color(0xFFD6DDE5), outlineVariant = Color(0xFFD6DDE5),
    error = Color(0xFFC2412D),
)
private val Dark = darkColorScheme(
    primary = Color(0xFF7D9BFF), onPrimary = Color(0xFF0B1626),
    background = Color(0xFF0B1626), onBackground = Color(0xFFE6EDF5),
    surface = Color(0xFF12223A), onSurface = Color(0xFFE6EDF5),
    surfaceVariant = Color(0xFF1A2D48), onSurfaceVariant = Color(0xFFC3CFDC),
    surfaceContainer = Color(0xFF12223A), surfaceContainerHigh = Color(0xFF172A45),
    outline = Color(0xFF22364F), outlineVariant = Color(0xFF22364F),
    error = Color(0xFFFF7A63),
)

private val Type = Typography().let { t ->
    t.copy(
        headlineLarge = t.headlineLarge.copy(fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.8).sp),
        headlineMedium = t.headlineMedium.copy(fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.6).sp),
        titleLarge = t.titleLarge.copy(fontWeight = FontWeight.Bold, letterSpacing = (-0.3).sp),
        titleMedium = t.titleMedium.copy(fontWeight = FontWeight.Bold),
        labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp),
    )
}

@Composable
fun WireTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalWire provides if (dark) DarkWire else LightWire) {
        MaterialTheme(colorScheme = if (dark) Dark else Light, typography = Type, content = content)
    }
}
