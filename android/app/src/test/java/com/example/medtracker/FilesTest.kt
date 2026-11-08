package com.example.medtracker

import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class FilesTest {
    @Test
    fun captureUsesCameraDirectlyAndGalleryKeepsChooser() {
        val pick = Intent(Intent.ACTION_GET_CONTENT)
        val output = Uri.parse("content://example/photos/test.jpg")
        val camera = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, output)

        val direct = Files.chooserIntent(pick, camera, true)
        assertSame(camera, direct)
        assertEquals(MediaStore.ACTION_IMAGE_CAPTURE, direct.action)
        assertEquals(output, direct.getParcelableExtra<Uri>(MediaStore.EXTRA_OUTPUT))

        val denied = Files.chooserIntent(pick, null, true)
        assertEquals(Intent.ACTION_CHOOSER, denied.action)
        assertSame(pick, denied.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))
        assertEquals(0, denied.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS)!!.size)

        val gallery = Files.chooserIntent(pick, camera, false)
        assertEquals(Intent.ACTION_CHOOSER, gallery.action)
        assertSame(pick, gallery.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))
        assertSame(camera, gallery.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS)!!.single())
    }
}
