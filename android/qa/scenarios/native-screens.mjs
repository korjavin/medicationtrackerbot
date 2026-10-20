// N1 first run, N2 local intro and the Health Connect rationale on the native token mirror
// (bd med-ckm5.14, docs/design/claude-design/ui_kits/app-v2/screens-native.html): one shot per
// state, for reading against the frames. Dispatch with font_scale=2.0 for N1 · 2x. No invite used.
// The pending move is a fake stash file (run-as, debug APK): the screens only check that it exists.
const START = /^Start$/;
const HINT = /^Your records are ready to move\. Paste or scan the invite for your new account\..*/;
const NOTE = /^A move to a cloud account is waiting\. Start here cancels it\..*/;

export default async function nativeScreens(ctx) {
  const { device, shell, pkg } = ctx;
  const stash = (on) => shell(on
    ? `run-as ${pkg} sh -c 'mkdir -p no_backup/move && echo {} > no_backup/move/vault.json'`
    : `run-as ${pkg} sh -c 'rm -rf no_backup/move; true'`);
  // At font_scale=2.0 rows sit below the fold and leave the UiAutomator tree: scroll the
  // column first (a no-op where it fits, as at 1.0).
  const down = async () => {
    await shell('input swipe 540 1500 540 400 300');
    await shell('input swipe 540 1500 540 400 300');
    await ctx.sleep(500);
  };
  const intro = async () => {
    await down();
    await device.tap({ text: 'Only on this device' });
    await ctx.waitFor({ text: 'Stored here, nowhere else' }, 10_000);
  };
  await stash(false);

  await ctx.step('N1: first run', () => ctx.launch());
  await ctx.shot('n1-first-run');
  await ctx.step('N1: Continue with an empty field shows the field error', async () => {
    await device.tap({ text: 'Continue' });
    await ctx.waitFor({ text: 'Paste or scan your invite first.' }, 5_000);
  });
  await ctx.shot('n1-empty-error');
  // The scanner is Play services' UI; on the emulator it may not open (then the field says so).
  await ctx.step('N1: Scan QR code', async () => {
    await device.tap({ desc: 'Scan QR code' });
    await ctx.sleep(4000);
  }).catch(() => {});
  await ctx.shot('n1-scan');

  await ctx.step('N1: a gone account keeps the address in the field', async () => {
    await ctx.launch();
    await ctx.openLink('https://nobody.qa.test/');
    await ctx.waitFor({ text: 'There is no account at nobody.qa.test.' }, 15_000);
    await ctx.waitFor({ text: 'Check the address, or ask whoever invited you for a new link.' }, 5_000);
    await ctx.waitFor({ clazz: 'android.widget.EditText', text: 'nobody.qa.test' }, 5_000);
  });
  await ctx.shot('n1-no-account');

  await ctx.step('N2: local intro', async () => {
    await ctx.launch();
    await intro();
    await ctx.waitFor({ text: START }, 5_000);
  });
  await ctx.shot('n2-local-intro');

  // The lock row shows only with a screen lock: a throwaway PIN, removed after.
  await shell('locksettings set-pin 1111');
  try {
    await ctx.step('N2: lock switch on', async () => {
      await ctx.launch();
      await intro();
      await down();
      await device.tap({ text: 'Lock with fingerprint or face' });
      await ctx.sleep(500);
    });
    await ctx.shot('n2-lock-on');
  } finally {
    await shell('locksettings clear --old 1111');
  }

  await stash(true);
  try {
    await ctx.step('N1: records ready to move', async () => {
      await ctx.launch();
      await ctx.waitFor({ text: HINT }, 10_000);
    });
    await ctx.shot('n1-move');
    await ctx.step('N2: pending-move warning; Back keeps the stash', async () => {
      await intro();
      await down();
      await ctx.waitFor({ text: NOTE }, 5_000);
      await ctx.waitFor({ text: 'Start and cancel the move' }, 5_000);
      await ctx.waitFor({ text: 'Open the new account instead' }, 5_000);
    });
    await ctx.shot('n2-pending-move');
    await ctx.step('N2: Open the new account instead → back to the invite', async () => {
      await device.tap({ text: 'Open the new account instead' });
      await ctx.waitFor({ text: HINT }, 5_000);
    });
  } finally {
    await stash(false);
  }

  await ctx.step('Health Connect rationale', async () => {
    await shell(`am start -W -a androidx.health.ACTION_SHOW_PERMISSIONS_RATIONALE -n ${pkg}/com.example.medtracker.PermissionsRationaleActivity`);
    await ctx.waitFor({ text: 'Health Connect access' }, 10_000);
  });
  await ctx.shot('hc-rationale');
}
