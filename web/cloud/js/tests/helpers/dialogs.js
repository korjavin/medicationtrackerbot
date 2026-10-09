// Loads the real in-page dialogs (web/static/js/core/utils.js — the same file
// signup.html and the account app load) into a JSDOM window, so cloud suites
// answer window.safeConfirm through its rendered buttons instead of stubbing a
// native confirm() (bd med-v83g: no native dialogs anywhere). The JSDOM must be
// built with { runScripts: 'outside-only' } so window.eval exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

// modal-manager + modal-history ride along exactly as signup.html loads them,
// so Back over a dialog cancels just the dialog (bd med-kj0w).
const STATIC_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../static/js');
export const SHELL_DIALOG_SCRIPTS = ['core/utils.js', 'components/wg-icons.js', 'core/modal-manager.js', 'features/modal-history.js'];
const SRCS = SHELL_DIALOG_SCRIPTS.map((f) => fs.readFileSync(path.join(STATIC_JS, f), 'utf8'));

export function installDialogs(window) {
  for (const src of SRCS) window.eval(src);
}

// The app's row overflow menu (WGRowActions) — devices.js mounts inside the
// account app, which loads it; the passkey shell does not. Call after
// installDialogs (it needs WGIcons).
const ROW_ACTIONS_SRC = fs.readFileSync(path.join(STATIC_JS, 'components/wg-row-actions.js'), 'utf8');
export function installRowActions(window) {
  window.eval(ROW_ACTIONS_SRC);
}

export function openDialog(document) {
  return document.querySelector('mt-modal.mt-confirm-modal');
}

// Waits for the dialog, clicks its confirm (accept=true) or cancel button, and
// returns the dialog element (detached by then) for title/message assertions.
export async function answerDialog(document, accept) {
  const modal = await vi.waitFor(() => {
    const m = openDialog(document);
    if (!m) throw new Error('no dialog open');
    return m;
  });
  modal.querySelector(accept ? '.mt-confirm-modal__confirm' : '.mt-confirm-modal__cancel').click();
  return modal;
}
