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
// The Play Integrity cloud project (bd med-nt9p.32.8.4): the ANDROID_PLAY_CLOUD_PROJECT_NUMBER
// repo variable, never committed. Unset (forks, QA) builds an app whose trial is unsupported.
val playCloudProjectNumber = providers.environmentVariable("ANDROID_PLAY_CLOUD_PROJECT_NUMBER").orNull?.trim()
    ?.takeIf { Regex("[0-9]{1,19}").matches(it) } ?: ""
// Native push (bd med-erq1.5, Push.kt): the Firebase app's public identifiers from the FIREBASE_*
// repo variables (owner bead med-erq1.7), never a committed google-services.json (it names the
// package). Any of the four unset: FIREBASE_APP_ID is empty and the app has no FCM at all.
val firebase = listOf("FIREBASE_APP_ID", "FIREBASE_API_KEY", "FIREBASE_PROJECT_ID", "FIREBASE_SENDER_ID")
    .associateWith { providers.environmentVariable(it).orNull?.trim()?.takeIf { v -> Regex("[A-Za-z0-9:._-]{1,128}").matches(v) } ?: "" }
    .let { m -> if (m.values.any { it.isEmpty() }) m.mapValues { "" } else m }
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
        buildConfigField("String", "PLAY_CLOUD_PROJECT_NUMBER", "\"$playCloudProjectNumber\"")
        firebase.forEach { (k, v) -> buildConfigField("String", k, "\"$v\"") }
        // The invite App Link's host (AndroidManifest.xml, bd med-ta2n.12.1). Unset (forks) gets a
        // reserved name that never resolves, so the filter matches no real link.
        manifestPlaceholders["baseDomain"] = baseDomain.ifEmpty { "unconfigured.invalid" }
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

// Local-mode spike (bd med-nt9p.32.1): the iOS spike page ios/LocalSpike, copied at build time
// into the DEBUG variant's assets as localspike/ (LocalSpikeActivity serves it). Release never
// gets it; nothing is committed under android/.
abstract class LocalSpikeAssets : DefaultTask() {
    @get:InputDirectory abstract val source: DirectoryProperty
    @get:OutputDirectory abstract val out: DirectoryProperty

    @TaskAction fun copy() {
        val dir = out.get().asFile
        dir.deleteRecursively()
        source.get().asFile.copyRecursively(dir.resolve("localspike"))
    }
}

val localSpikeAssets = tasks.register<LocalSpikeAssets>("localSpikeAssets") {
    source.set(rootProject.layout.projectDirectory.dir("../ios/LocalSpike"))
}

androidComponents {
    onVariants(selector().withBuildType("debug")) { variant ->
        variant.sources.assets?.addGeneratedSourceDirectory(localSpikeAssets, LocalSpikeAssets::out)
    }
}

dependencies {
    // >= 1.12: WebSettingsCompat.setWebAuthenticationSupport (passkeys in WebView).
    implementation("androidx.webkit:webkit:1.12.1")
    // FileProvider: downloads to share, camera shots for the file chooser (Files.kt).
    implementation("androidx.core:core:1.13.1")
    // Health Connect read import (bd med-nt9p.8); coroutines for its suspend API.
    implementation("androidx.health.connect:connect-client:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.7.3")
    // Local mode's free trial (bd med-nt9p.32.8.4): Play Integrity standard requests, and
    // GoogleApiAvailability for attest.status.
    implementation("com.google.android.play:integrity:1.4.0")
    implementation("com.google.android.gms:play-services-base:18.5.0")
    // Play Install Referrer (bd med-ta2n.12.1, contract med-ta2n.7 §4): the invite a Play install
    // came from, read once on a true first install.
    implementation("com.android.installreferrer:installreferrer:2.2")
    // Native push (bd med-erq1.5): FCM only, initialized by hand from BuildConfig (Push.kt) —
    // no google-services plugin, no analytics.
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
}
