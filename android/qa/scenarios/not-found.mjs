// An account the local cloud does not have: the server's 404 → the shell's "There is no account at …" screen.
export default async function notFound(ctx) {
  await ctx.step('launch on first run', () => ctx.launch());
  await ctx.step('Open https://nobody.qa.test/ shows the 404 screen', async () => {
    await ctx.openAccount('https://nobody.qa.test/');
    await ctx.waitFor({ text: /There is no account at nobody\..*/ }, 5_000);
  });
  await ctx.shot('no-account');
}
