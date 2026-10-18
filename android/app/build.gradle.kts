plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The real package lives in the ANDROID_PACKAGE repo variable, never in this
// public tree (epic med-nt9p owner rule 4); the placeholder only keeps forks
// and unconfigured runs compiling.
val appPackage = providers.environmentVariable("ANDROID_PACKAGE").orNull?.takeIf { it.isNotBlank() }
    ?: "com.example.medtracker"
val versionCodeEnv = providers.environmentVariable("ANDROID_VERSION_CODE").orNull?.toIntOrNull() ?: 1
val uploadKeystore = providers.environmentVariable("ANDROID_UPLOAD_KEYSTORE").orNull

android {
    // The code package; applicationId (the Play identity) comes from the env.
    namespace = "com.example.medtracker"
    compileSdk = 35

    defaultConfig {
        applicationId = appPackage
        minSdk = 34
        targetSdk = 35
        versionCode = versionCodeEnv
        versionName = "0.1.$versionCodeEnv"
    }

    // Release is signed with the Play upload key only on the dispatch path,
    // where CI decodes it to ANDROID_UPLOAD_KEYSTORE. Debug builds use
    // ~/.android/debug.keystore, which CI fills from a secret so the debug
    // certificate (and its asset-links fingerprint) is stable across runs.
    signingConfigs {
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
    testImplementation("junit:junit:4.13.2")
}
