plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.frontierwire.core"
    compileSdk = 35
    defaultConfig {
        minSdk = 26
        buildConfigField("String", "API_BASE", "\"${providers.gradleProperty("wire.apiBase").get()}\"")
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    api(libs.androidx.core.ktx)
    api(platform(libs.compose.bom))
    api(libs.compose.ui)
    api(libs.compose.material3)
    api(libs.compose.material.icons)
    api(libs.compose.ui.tooling.preview)
    api(libs.androidx.activity.compose)
    api(libs.androidx.lifecycle.runtime)
    api(libs.androidx.lifecycle.viewmodel)
    api(libs.androidx.navigation.compose)
    api(libs.okhttp)
    api(libs.kotlinx.serialization.json)
    api(libs.kotlinx.coroutines.android)
    api(libs.androidx.browser)
    api(libs.coil.compose)
    // Firebase brings an old Fragment; ActivityResult needs 1.3+.
    api(libs.androidx.fragment)
}
