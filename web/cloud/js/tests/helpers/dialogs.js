// Loads the real in-page dialogs (web/static/js/core/utils.js — the same file
// signup.html and the account app load) into a JSDOM window, so cloud suites
// answer window.safeConfirm through its rendered buttons instead of stubbing a
// native confirm() (bd med-v83g: no native dialogs anywhere). The JSDOM must be
// built with { runScripts: 'outside-only' } so window.eval exists.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';

const UTILS_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../static/js/core/utils.js');
const UTILS_SRC = fs.readFileSync(UTILS_PATH, 'utf8');

export function installDialogs(window) {
  window.eval(UTILS_SRC);
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
