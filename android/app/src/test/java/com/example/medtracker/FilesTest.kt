package com.example.medtracker

import android.content.Intent
import android.app.Activity
import android.content.ClipData
import android.net.Uri
import android.os.Looper
import android.provider.MediaStore
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayInputStream

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
        val files = Files(activity, pickerFileUri = { Uri.fromFile(it) }, copyAsync = { job ->
            Thread(job).apply { start(); join() }
        }) { null }
        val field = Files::class.java.getDeclaredField("chooser").apply { isAccessible = true }
        val pickerField = Files::class.java.getDeclaredField("pickerResult").apply { isAccessible = true }
        var received: Array<Uri>? = null
        var callbackOnMain = false
        val callback = ValueCallback<Array<Uri>> { received = it; callbackOnMain = Looper.myLooper() == Looper.getMainLooper() }
        val first = Uri.parse("content://media/picker/one")
        val second = Uri.parse("content://media/picker/two")
        val firstBytes = byteArrayOf(1, 2, 3)
        val secondBytes = byteArrayOf(4, 5)
        shadowOf(activity.contentResolver).registerInputStream(first, ByteArrayInputStream(firstBytes))
        shadowOf(activity.contentResolver).registerInputStream(second, ByteArrayInputStream(secondBytes))
        field.set(files, callback)
        pickerField.setBoolean(files, true)
        val clip = ClipData.newRawUri("", first).apply { addItem(ClipData.Item(second)) }
        files.onActivityResult(Files.REQ_CHOOSER, Activity.RESULT_OK, Intent().apply { clipData = clip })
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(callbackOnMain)
        assertEquals(2, received!!.size)
        assertArrayEquals(firstBytes, java.io.File(received!![0].path!!).readBytes())
        assertArrayEquals(secondBytes, java.io.File(received!![1].path!!).readBytes())
        assertTrue(received!![0].path!!.endsWith(".jpg"))
        field.set(files, callback)
        files.onActivityResult(Files.REQ_CHOOSER, Activity.RESULT_OK, Intent().setData(first))
        assertArrayEquals(arrayOf(first), received)
        field.set(files, callback)
        files.onActivityResult(Files.REQ_CHOOSER, Activity.RESULT_CANCELED, null)
        assertNull(received)
    }
}
