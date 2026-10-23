package com.frontierwire.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import com.android.resources.NightMode
import com.frontierwire.core.WireTheme
import com.frontierwire.core.json
import org.junit.Rule
import org.junit.Test

/** Renders the feed on the JVM (no emulator): ./gradlew :app:recordPaparazziDebug */
class ScreensShot {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_6, theme = "android:Theme.Material.Light.NoActionBar")

    private val snap = json.decodeFromString(Snapshot.serializer(), javaClass.classLoader!!.getResource("snapshot.json")!!.readText())

    private fun feed(dark: Boolean) {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_6.copy(nightMode = if (dark) NightMode.NIGHT else NightMode.NOTNIGHT))
        paparazzi.snapshot {
            WireTheme(dark = dark) {
                LazyColumn(Modifier.background(MaterialTheme.colorScheme.background), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    item { Header("Frontier Wire", "The AI news, as it breaks") }
                    items(snap.stories.take(4).mapIndexed { i, s -> i to s.copy(image = null) }) { (i, s) -> StoryCard(s, reason = if (i == 1) "Because you follow DeepSeek" else null, onOpen = {}, onMore = {}) }
                }
            }
        }
    }

    @Test fun todayLight() = feed(false)
    @Test fun todayDark() = feed(true)
}
