// Standalone; clears the app. Gallery and barcode Use photo open the picker without CAMERA →
// Photo asks for CAMERA and opens camera → Back → take and confirm a shot → Food review receives it.
// Then a seeded JPEG is selected from Gallery and its bytes are read in Food review.
// The AI parser port is held pending, avoiding a live provider request.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export default async function foodPhoto(ctx) {
  const bytes = readFileSync('docs/logo.jpg');
  const expected = createHash('sha256').update(bytes).digest('hex');
  const file = '/sdcard/Pictures/qa-gallery-real.jpg';
  await ctx.device.push(bytes, file);
  await ctx.shell(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file://${file}`);
  await ctx.sleep(20000);
  await ctx.shell(`pm clear ${ctx.pkg}`);
  const page = await ctx.launchLocal('today');
  await page.evaluate(() => window.switchTab('food'));
  await page.locator('#food-view').waitFor({ state: 'visible' });
  await page.evaluate(() => window.showAddFoodModal());
  await page.locator('#food-add-photo-btn').waitFor({ state: 'visible' });

  await ctx.step('Gallery opens the picker without camera permission', async () => {
    await page.click('#food-add-gallery-btn');
    await ctx.sleep(5000);
    const activity = await ctx.shell('dumpsys activity activities');
    const resumed = activity.split('\n').find((line) => line.includes('ResumedActivity')) || '';
    ctx.results.foodPhoto = { galleryResumed: resumed };
    if (!/photopicker/i.test(resumed) || /intentresolver|chooser/i.test(resumed)) throw new Error(`Gallery did not open picker: ${resumed}`);
    const permissions = await ctx.shell(`dumpsys package ${ctx.pkg}`);
    if (!/android\.permission\.CAMERA: granted=false/.test(permissions)) throw new Error('Gallery granted CAMERA unexpectedly');
    // waitFor dismisses the emulator's occasional launcher ANR before Back is sent.
    await ctx.waitFor({ text: 'Photos' });
    await ctx.shot('gallery-picker');
    await ctx.shell('input keyevent KEYCODE_BACK');
    await ctx.waitFor({ clazz: 'android.webkit.WebView' });
    await page.locator('#food-add-gallery-btn').waitFor({ state: 'visible' });
    if (await page.locator('#food-add-review-list').isVisible()) throw new Error('Cancellation opened Food review');
  });
  await ctx.step('Barcode Use photo opens the picker without camera permission', async () => {
    // Isolate the still-image path: disable live barcode scanning so opening the scanner
    // does not itself request camera access before the Use photo button is tapped.
    await page.evaluate(() => { window.Barcode.supportsLiveScan = () => false; });
    await page.click('#food-add-scan-btn');
    await page.locator('#food-scanner-use-photo-btn').waitFor({ state: 'visible' });
    await page.click('#food-scanner-use-photo-btn');
    await ctx.sleep(5000);
    const activity = await ctx.shell('dumpsys activity activities');
    const resumed = activity.split('\n').find((line) => line.includes('ResumedActivity')) || '';
    ctx.results.foodPhoto.barcodeResumed = resumed;
    if (!/photopicker/i.test(resumed) || /intentresolver|chooser/i.test(resumed)) throw new Error(`Barcode photo did not open picker: ${resumed}`);
    const permissions = await ctx.shell(`dumpsys package ${ctx.pkg}`);
    if (!/android\.permission\.CAMERA: granted=false/.test(permissions)) throw new Error('Barcode photo granted CAMERA unexpectedly');
    await ctx.waitFor({ text: 'Photos' });
    await ctx.shot('barcode-picker');
    await ctx.shell('input keyevent KEYCODE_BACK');
    await ctx.waitFor({ clazz: 'android.webkit.WebView' });
    await page.click('#food-scanner-close-btn');
    await page.locator('#food-add-photo-btn').waitFor({ state: 'visible' });
  });
  await ctx.step('Photo asks for camera and opens it directly', async () => {
    await page.click('#food-add-photo-btn');
    await ctx.waitFor({ text: /While using the app/i }, 30_000);
    await ctx.device.tap({ text: /While using the app/i });
    await ctx.sleep(5000);
    const activity = await ctx.shell('dumpsys activity activities');
    const resumed = activity.split('\n').find((line) => line.includes('ResumedActivity')) || '';
    ctx.results.foodPhoto.photoResumed = resumed;
    if (!/camera/i.test(resumed) || /intentresolver|chooser/i.test(resumed)) throw new Error(`Photo did not open camera: ${resumed}`);
    // The freshly booted emulator may put a launcher ANR over the camera. Back would dismiss
    // that dialog instead of cancelling capture, so clear it before taking evidence or leaving.
    if (await ctx.device.wait({ text: /.*isn['’]t responding.*/ }, { timeout: 2000 }).then(() => true, () => false)) {
      await ctx.device.tap({ text: 'Wait' });
    }
    await ctx.shot('photo-camera');
    await ctx.shell('input keyevent KEYCODE_BACK');
    await ctx.waitFor({ clazz: 'android.webkit.WebView' });
  });
  await ctx.step('Camera shot returns to Food review', async () => {
    // Keep the real Food review path open without making an external AI request. Capture the
    // File passed to its existing parseMealFromPhoto(file, {dryRun:true}) port.
    await page.evaluate(() => {
      window.CloudFoodAI.parseMealFromPhoto = (file) => {
        window.__qaFoodPhoto = { size: file.size, type: file.type };
        return new Promise(() => {});
      };
    });
    await page.click('#food-add-photo-btn');
    await ctx.sleep(3000);
    const size = await ctx.shell('wm size');
    const match = /Physical size: (\d+)x(\d+)/.exec(size);
    if (!match) throw new Error(`no screen size: ${size}`);
    // The AOSP emulator camera's shutter is centered at 90.6% of this portrait screen.
    await ctx.device.input.tap({ x: Math.round(Number(match[1]) / 2), y: Math.round(Number(match[2]) * 0.906) });
    await ctx.sleep(3000);
    await ctx.shot('camera-captured');
    await ctx.shell('uiautomator dump /sdcard/food-photo.xml');
    ctx.results.foodPhoto.captureUi = await ctx.shell('cat /sdcard/food-photo.xml');
    const done = { desc: /^(Done|OK|Confirm|Accept)$/i };
    await ctx.waitFor(done, 15_000);
    await ctx.device.tap(done);
    await ctx.waitFor({ clazz: 'android.webkit.WebView' });
    await page.waitForFunction(() => window.__qaFoodPhoto?.size > 0, null, { timeout: 30_000 });
    ctx.results.foodPhoto.returned = await page.evaluate(() => window.__qaFoodPhoto);
    await page.locator('#food-add-review-list').waitFor({ state: 'visible' });
    await ctx.shot('photo-review');
  });
  await ctx.step('Gallery selected JPEG reaches Food review', async () => {
    await page.click('#food-add-close-btn');
    await page.evaluate(() => window.showAddFoodModal());
    await page.locator('#food-add-gallery-btn').waitFor({ state: 'visible' });
    await page.evaluate(() => {
      window.CloudFoodAI.parseMealFromPhoto = (file) => {
        file.arrayBuffer().then(async (bytes) => {
          const hash = await crypto.subtle.digest('SHA-256', bytes);
          window.__qaGalleryPhoto = { size: bytes.byteLength, type: file.type,
            sha256: [...new Uint8Array(hash)].map(x => x.toString(16).padStart(2, '0')).join('') };
        }).catch((error) => { window.__qaGalleryError = `${error.name}: ${error.message}`; });
        return new Promise(() => {});
      };
    });
    await page.click('#food-add-gallery-btn');
    await ctx.waitFor({ text: 'Photos' });
    await ctx.sleep(3000);
    await ctx.shot('gallery-seeded');
    const screen = await ctx.shell('wm size');
    const match = /Physical size: (\d+)x(\d+)/.exec(screen);
    if (!match) throw new Error(`no screen size: ${screen}`);
    // First thumbnail in the system picker on the portrait emulator.
    await ctx.device.input.tap({ x: Math.round(Number(match[1]) * 0.17), y: Math.round(Number(match[2]) * 0.34) });
    await ctx.waitFor({ clazz: 'android.webkit.WebView' }, 30_000);
    await page.waitForFunction(() => window.__qaGalleryPhoto?.size > 0 || window.__qaGalleryError, null, { timeout: 30_000 });
    const error = await page.evaluate(() => window.__qaGalleryError);
    if (error) throw new Error(`Selected JPEG read failed: ${error}`);
    ctx.results.foodPhoto.galleryReturned = await page.evaluate(() => window.__qaGalleryPhoto);
    ctx.results.foodPhoto.galleryExpected = { size: bytes.length, type: 'image/jpeg', sha256: expected };
    const actual = ctx.results.foodPhoto.galleryReturned;
    if (actual.sha256 !== expected || actual.size !== bytes.length || actual.type !== 'image/jpeg') throw new Error('Selected image bytes differ from seeded JPEG');
    await page.locator('#food-add-review-list').waitFor({ state: 'visible' });
    await ctx.shot('gallery-review');
    await ctx.shell(`rm -f ${file}`);
  });
}
