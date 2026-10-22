plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}
// Firebase push is on once app/google-services.json is in place (not in git).
if (file("google-services.json").exists()) apply(plugin = libs.plugins.google.services.get().pluginId)

android {
    namespace = "com.frontierwire.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.frontierwire.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
        // The Google sign-in web client id (from Google Cloud), if set.
        buildConfigField("String", "GOOGLE_CLIENT_ID", "\"${providers.gradleProperty("wire.googleClientId").getOrElse("")}\"")
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            // Until a Play signing key is set up, release builds are signed with the debug key.
            signingConfig = signingConfigs.getByName("debug")
        }
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
    implementation(project(":core"))
    implementation(libs.androidx.work)
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.kotlinx.coroutines.play)
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play)
    implementation(libs.googleid)
    debugImplementation(libs.compose.ui.tooling)
}
