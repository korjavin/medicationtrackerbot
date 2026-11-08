// Exercise the real Food tiles and Android's camera / chooser surfaces.
export default async function foodPhoto(ctx) {
  await ctx.shell(`pm clear ${ctx.pkg}`);
  await ctx.shell(`pm grant ${ctx.pkg} android.permission.CAMERA`);
  const page = await ctx.launchLocal('today');
  await page.evaluate(() => window.switchTab('food'));
  await page.locator('#food-view').waitFor({ state: 'visible' });
  await page.evaluate(() => window.showAddFoodModal());
  await page.locator('#food-add-photo-btn').waitFor({ state: 'visible' });

  await ctx.step('Photo opens the camera directly', async () => {
    await page.click('#food-add-photo-btn');
    await ctx.sleep(5000);
    const activity = await ctx.shell('dumpsys activity activities');
    const resumed = activity.split('\n').find((line) => line.includes('ResumedActivity')) || '';
    ctx.results.foodPhoto = { photoResumed: resumed };
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
  await ctx.step('Gallery opens the chooser', async () => {
    await page.click('#food-add-gallery-btn');
    await ctx.waitFor({ text: 'Camera' }, 30_000);
    // Android's installed picker labels vary: the API 34 emulator calls it Media.
    await ctx.waitFor({ text: /^(Files|Media)$/ }, 30_000);
    await ctx.shot('gallery-chooser');
    await ctx.shell('input keyevent KEYCODE_BACK');
    await ctx.waitFor({ clazz: 'android.webkit.WebView' });
  });
}
