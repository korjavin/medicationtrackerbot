plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The real package lives in the ANDROID_PACKAGE repo variable, never in this
// public tree (epic med-nt9p owner rule 4); the placeholder only keeps forks
// and unconfigured runs compiling.
val appPackage = providers.environmentVariable("ANDROID_PACKAGE").orNull?.takeIf { it.isNotBlank() }
    ?: "com.example.medtracker"
// The deployment's base domain is never committed either (owner rule 4): CI
// passes the CLOUD_BASE_DOMAIN repo variable, masked. Unset (forks) builds an
// app whose first run says it has no service configured.
val baseDomain = providers.environmentVariable("CLOUD_BASE_DOMAIN").orNull?.trim()?.lowercase()
    ?.takeIf { Regex("[a-z0-9-]+(\\.[a-z0-9-]+)+").matches(it) } ?: ""
val versionCodeEnv = providers.environmentVariable("ANDROID_VERSION_CODE").orNull?.toIntOrNull() ?: 1
val uploadKeystore = providers.environmentVariable("ANDROID_UPLOAD_KEYSTORE").orNull
// CI decodes the stable debug key here; unset (PRs, local) keeps the default debug key.
val debugKeystore = providers.environmentVariable("ANDROID_DEBUG_KEYSTORE").orNull?.takeIf { it.isNotBlank() }

android {
    // The code package; applicationId (the Play identity) comes from the env.
    namespace = "com.example.medtracker"
    compileSdk = 36

    defaultConfig {
        applicationId = appPackage
        minSdk = 34
        targetSdk = 36
        versionCode = versionCodeEnv
        versionName = "0.1.$versionCodeEnv"
        buildConfigField("String", "BASE_DOMAIN", "\"$baseDomain\"")
    }

    buildFeatures {
        buildConfig = true
    }

    // Release is signed with the Play upload key only on the dispatch path,
    // where CI decodes it to ANDROID_UPLOAD_KEYSTORE. Debug builds use
    // ~/.android/debug.keystore, which CI fills from a secret so the debug
    // certificate (and its asset-links fingerprint) is stable across runs.
    signingConfigs {
        // Explicit path: AGP's ~/.android lookup is not reliable on the runner.
        if (debugKeystore != null) {
            getByName("debug") {
                storeFile = file(debugKeystore)
                storePassword = "android"
                keyAlias = "androiddebugkey"
                keyPassword = "android"
            }
        }
        if (uploadKeystore != null) {
            create("upload") {
                storeFile = file(uploadKeystore)
                storePassword = System.getenv("ANDROID_UPLOAD_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ANDROID_UPLOAD_KEY_ALIAS")
                keyPassword = System.getenv("ANDROID_UPLOAD_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            if (uploadKeystore != null) signingConfig = signingConfigs.getByName("upload")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // >= 1.12: WebSettingsCompat.setWebAuthenticationSupport (passkeys in WebView).
    implementation("androidx.webkit:webkit:1.12.1")
    // QR first run: Play services' scanner UI — no camera permission, no bundled model.
    implementation("com.google.android.gms:play-services-code-scanner:16.1.0")
    // Health Connect read import (bd med-nt9p.8); coroutines for its suspend API.
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    testImplementation("junit:junit:4.13.2")
}
