#!/usr/bin/env node
// Regenerates the privacy boundary table in docs/cloud-mode.md from
// web/cloud/js/privacy-manifest.js (bd med-yor.4).
//
//   pnpm privacy:docs
//
// The guard test asserts the committed doc equals what this prints, so editing
// the table by hand fails CI — change the manifest and re-run this instead.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderBoundaryTable, GENERATED_BEGIN, GENERATED_END } from '../web/cloud/js/privacy-manifest.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(REPO_ROOT, 'docs/cloud-mode.md');

const md = fs.readFileSync(DOC, 'utf8');
const start = md.indexOf(GENERATED_BEGIN);
const end = md.indexOf(GENERATED_END);
if (start < 0 || end < 0 || end < start) {
  console.error(`docs/cloud-mode.md is missing the generated-table markers:\n${GENERATED_BEGIN}\n${GENERATED_END}`);
  process.exit(1);
}

const block = `${GENERATED_BEGIN}\n\n${renderBoundaryTable()}\n\n${GENERATED_END}`;
const next = md.slice(0, start) + block + md.slice(end + GENERATED_END.length);
if (next === md) {
  console.log('docs/cloud-mode.md privacy boundary table already up to date.');
} else {
  fs.writeFileSync(DOC, next);
  console.log('docs/cloud-mode.md privacy boundary table regenerated.');
}
