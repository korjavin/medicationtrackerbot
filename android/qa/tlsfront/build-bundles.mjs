// B2 fixture setup, invoked by the EXISTING android-qa workflow, never shipped.
// Go's embed overlay lets A/B contain real coherent deployment-stamped bytes
// from one checkout without mutating source or the native app's local bundle.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const manifest = {};
if (!process.env.RUNNER_TEMP) throw new Error('RUNNER_TEMP unset');
for (const [label, stamp] of [['A', '20990101-0001'], ['B', '20990101-0002']]) {
  const dir = join(process.env.RUNNER_TEMP, `bundle-${label}`);
  mkdirSync(dir);
  const Replace = {};
  const hashes = {};
  for (const path of ['web/static/index.html', 'web/static/wg-primitives.html', 'web/cloud/sw.js']) {
    const body = readFileSync(path, 'utf8').replaceAll('CACHE_VERSION_PLACEHOLDER', `v${stamp}`)
      .replaceAll('TIMESTAMP_PLACEHOLDER', stamp).replaceAll('VERSION_PLACEHOLDER', stamp);
    const target = join(dir, path.replaceAll('/', '-'));
    writeFileSync(target, body);
    Replace[resolve(path)] = target;
    hashes[path] = createHash('sha256').update(body).digest('hex');
  }
  const overlay = join(dir, 'overlay.json');
  writeFileSync(overlay, JSON.stringify({ Replace }));
  const binary = join(process.env.RUNNER_TEMP, `cloud-${label}`);
  execFileSync('go', ['build', '-overlay', overlay, '-o', binary, './cmd/cloud'], { stdio: 'inherit' });
  manifest[label] = { stamp, hashes, binarySha256: createHash('sha256').update(readFileSync(binary)).digest('hex') };
}
writeFileSync(join(process.env.RUNNER_TEMP, 'bundles.json'), JSON.stringify(manifest, null, 2));
