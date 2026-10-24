package com.example.medtracker

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import java.io.ByteArrayInputStream

/**
 * local.erase's wipe (bd med-r1j2.8): the local origin's storage, and only that origin's — the
 * joined account's origin shares the WebView profile and must survive. WebStorage.deleteOrigin
 * leaves localStorage, and androidx.webkit's site deletion needs a newer WebView than the shell's
 * minimum, so a throwaway WebView (no bridge) loads one page on the asset origin that clears
 * localStorage, every IndexedDB database, Cache Storage and service workers from inside it, and
 * reports through its title. deleteOrigin then sweeps whatever quota storage is left.
 * Main thread only. [done] gets true on success, false on a script error or the 10 s timeout.
 */
object LocalWipe {
    private const val PATH = "/__wg_local_wipe"
    private const val PAGE = """<!doctype html><title>wiping</title><script>
(async () => {
  try {
    localStorage.clear();
    sessionStorage.clear();
    for (const d of await indexedDB.databases()) {
      // Blocked: keep waiting for success; the native timeout fails it. An error fails the wipe.
      await new Promise((ok, fail) => { const q = indexedDB.deleteDatabase(d.name); q.onsuccess = ok; q.onerror = () => fail(q.error); });
    }
    if (self.caches) for (const k of await caches.keys()) await caches.delete(k);
    if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
    document.title = 'wg-wiped';
  } catch (e) {
    document.title = 'wg-wipe-failed';
  }
})();
</script>"""

    fun run(context: Context, done: (Boolean) -> Unit) {
        val web = WebView(context)
        val main = Handler(Looper.getMainLooper())
        var finished = false
        fun finish(ok: Boolean) {
            if (finished) return
            finished = true
            main.removeCallbacksAndMessages(web)
            web.destroy()
            WebStorage.getInstance().deleteOrigin(LocalOrigin.HOME.removeSuffix("/"))
            done(ok)
        }
        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.webViewClient = object : WebViewClient() {
            // Never the network, never the bundled app: the wipe page, else an empty 404.
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val ours = request.url.host == LocalOrigin.HOST && request.url.path == PATH
                return WebResourceResponse(
                    if (ours) "text/html" else "text/plain", "utf-8", if (ours) 200 else 404, if (ours) "OK" else "Not Found",
                    mapOf("Cache-Control" to "no-store"),
                    ByteArrayInputStream(if (ours) PAGE.toByteArray() else ByteArray(0)),
                )
            }
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onReceivedTitle(view: WebView, title: String?) {
                if (title == "wg-wiped" || title == "wg-wipe-failed") main.post { finish(title == "wg-wiped") }
            }
        }
        main.postAtTime({ finish(false) }, web, android.os.SystemClock.uptimeMillis() + 10_000)
        web.loadUrl("https://${LocalOrigin.HOST}$PATH")
    }
}
