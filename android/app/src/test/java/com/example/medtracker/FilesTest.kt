package com.example.medtracker

import android.content.Intent
import android.app.Activity
import android.content.ClipData
import android.net.Uri
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertArrayEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], manifest = Config.NONE)
class FilesTest {
    @Test
    fun captureGalleryAndNonMediaSelectTheirOwnIntents() {
        val pick = Intent(Intent.ACTION_GET_CONTENT)
        val single = WebChromeClient.FileChooserParams.MODE_OPEN
        val output = Uri.parse("content://example/photos/test.jpg")
        val camera = Intent(MediaStore.ACTION_IMAGE_CAPTURE).putExtra(MediaStore.EXTRA_OUTPUT, output)

        val direct = Files.chooserIntent(pick, camera, true, listOf("image/*"), single)
        assertSame(camera, direct)
        assertEquals(MediaStore.ACTION_IMAGE_CAPTURE, direct.action)
        assertEquals(output, direct.getParcelableExtra<Uri>(MediaStore.EXTRA_OUTPUT))

        val denied = Files.chooserIntent(pick, null, true, listOf("image/*"), single)
        assertEquals(MediaStore.ACTION_PICK_IMAGES, denied.action)
        val gallery = Files.chooserIntent(pick, null, false, listOf("image/*"), single)
        assertEquals(MediaStore.ACTION_PICK_IMAGES, gallery.action)
        assertEquals("image/*", gallery.type)
        assertNull(gallery.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS))
        val restore = Files.chooserIntent(pick, null, false, null, single)
        assertEquals(Intent.ACTION_CHOOSER, restore.action)
        assertSame(pick, restore.getParcelableExtra<Intent>(Intent.EXTRA_INTENT))
        assertNull(restore.getParcelableArrayExtra(Intent.EXTRA_INITIAL_INTENTS))
        val video = Files.chooserIntent(pick, null, false, listOf("video/*"), single)
        assertEquals("video/*", video.type)
        val mixed = Files.chooserIntent(pick, null, false, listOf("image/*", "video/*"), single)
        assertEquals(MediaStore.ACTION_PICK_IMAGES, mixed.action)
        assertNull(mixed.type)
        val multi = Files.chooserIntent(pick, null, false, listOf("image/*"), WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
        assertEquals(MediaStore.getPickImagesMaxLimit(), multi.getIntExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, 0))
    }

    @Test
    fun pickerResultPassesUrisAndCancellationToWebView() {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val files = Files(activity) { null }
        val field = Files::class.java.getDeclaredField("chooser").apply { isAccessible = true }
        var received: Array<Uri>? = null
        val callback = ValueCallback<Array<Uri>> { received = it }
        val first = Uri.parse("content://media/picker/one")
        val second = Uri.parse("content://media/picker/two")
        field.set(files, callback)
        files.onActivityResult(Files.REQ_CHOOSER, Activity.RESULT_OK, Intent().setData(first))
        assertArrayEquals(arrayOf(first), received)
        field.set(files, callback)
        val clip = ClipData.newRawUri("", first).apply { addItem(ClipData.Item(second)) }
        files.onActivityResult(Files.REQ_CHOOSER, Activity.RESULT_OK, Intent().apply { clipData = clip })
        assertArrayEquals(arrayOf(first, second), received)
        field.set(files, callback)
        files.onActivityResult(Files.REQ_CHOOSER, Activity.RESULT_CANCELED, null)
        assertNull(received)
    }
}
