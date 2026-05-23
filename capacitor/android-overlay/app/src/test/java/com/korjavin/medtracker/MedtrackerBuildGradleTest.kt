package com.korjavin.medtracker

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// Sanity guard: medtracker.build.gradle must apply the Kotlin Android plugin
// and declare the kotlin-stdlib dependency, otherwise AGP silently drops the
// overlay's .kt sources and the APK ships a stub MainActivity that never
// spawns the embedded Go binary.
//
// The Capacitor 6 default app/build.gradle only applies
// `com.android.application`. We add the Kotlin plugin via the
// `apply from: 'medtracker.build.gradle'` stanza wired in by the CI workflow.
// This test catches a regression where someone removes that plugin line.
//
// The gradle file is located by walking up from any plausible test working
// directory: gradle runs tests from the app module root
// (capacitor/android/app or capacitor/android-overlay/app depending on which
// tree gradle picked up).
class MedtrackerBuildGradleTest {

    @Test
    fun medtrackerBuildGradleAppliesKotlinAndroidPlugin() {
        val gradle = locateMedtrackerBuildGradle()
        val content = gradle.readText()
        assertTrue(
            "medtracker.build.gradle must apply 'org.jetbrains.kotlin.android' " +
                "or the overlay's .kt sources will not compile",
            content.contains("apply plugin: 'org.jetbrains.kotlin.android'"),
        )
    }

    @Test
    fun medtrackerBuildGradleDeclaresKotlinStdlib() {
        val gradle = locateMedtrackerBuildGradle()
        val content = gradle.readText()
        assertTrue(
            "medtracker.build.gradle must declare an explicit kotlin-stdlib " +
                "to keep compile- and runtime-stdlib in agreement",
            content.contains("org.jetbrains.kotlin:kotlin-stdlib"),
        )
    }

    private fun locateMedtrackerBuildGradle(): File {
        // Search relative to user.dir, walking up a few levels to handle both
        // the source overlay (android-overlay/app/medtracker.build.gradle)
        // and the applied tree (android/app/medtracker.build.gradle).
        val candidates = listOf(
            "medtracker.build.gradle",
            "app/medtracker.build.gradle",
            "android-overlay/app/medtracker.build.gradle",
            "../medtracker.build.gradle",
            "../../capacitor/android-overlay/app/medtracker.build.gradle",
        )
        val cwd = File(System.getProperty("user.dir"))
        for (rel in candidates) {
            val f = File(cwd, rel)
            if (f.exists()) return f
        }
        val found: File? = null
        assertNotNull(
            "could not locate medtracker.build.gradle from ${cwd.absolutePath}",
            found,
        )
        error("unreachable")
    }
}
