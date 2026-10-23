package com.frontierwire.admin

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
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The changelog as the admin app shows it: ./gradlew :admin:recordPaparazziDebug */
class ScreensShot {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_6, theme = "android:Theme.Material.Light.NoActionBar")

    private val log = json.decodeFromString(Changelog.serializer(), javaClass.classLoader!!.getResource("changelog.json")!!.readText())

    @Test fun decodesTheChangelog() = assertTrue(log.entries.size == 6 && log.entries.all { it.title.isNotBlank() && it.body.isNotBlank() })

    private fun changelog(dark: Boolean) {
        paparazzi.unsafeUpdateConfig(deviceConfig = DeviceConfig.PIXEL_6.copy(nightMode = if (dark) NightMode.NIGHT else NightMode.NOTNIGHT))
        paparazzi.snapshot {
            WireTheme(dark = dark) {
                LazyColumn(Modifier.background(MaterialTheme.colorScheme.background), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    items(log.entries.take(3)) { e -> FeatureCard(e, {}, startOpen = e == log.entries.first()) }
                }
            }
        }
    }

    @Test fun changelogLight() = changelog(false)
    @Test fun changelogDark() = changelog(true)
}
