// Toy record-type UI (Task 3): encrypted notes exist only to exercise
// sync.js end to end (create/edit/list, cross-device convergence) — labelled
// as a demo, not a real feature. Real record types arrive in C1.
import { pullOnOpen, listNotes, createNote, updateNote, deleteNote, describeSyncStatus } from './sync.js';

export function renderNotes(app, ctx, onExit) {
  app.innerHTML = `
    <section class="wizard-step">
      <h1>Notes <small>(sync demo)</small></h1>
      <p id="sync-status" class="sync-status">Syncing&hellip;</p>
      <p class="wizard-error" id="notes-error"></p>
      <form id="note-form" class="note-form">
        <input id="note-text" placeholder="New note" autocomplete="off" />
        <button type="submit">Add</button>
      </form>
      <ul id="note-list" class="note-list"></ul>
      <button id="notes-back">Back</button>
    </section>`;

  app.querySelector('#notes-back').addEventListener('click', onExit);
  app.querySelector('#note-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = app.querySelector('#note-text');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    createNote(ctx, text)
      .then(() => refresh(app, ctx))
      .catch((err) => showError(app, err));
  });

  refresh(app, ctx);
}

async function refresh(app, ctx) {
  // pullOnOpen swallows network failures internally (offline flag), so this
  // still renders from the local mirror when offline; the try/catch is for a
  // hard failure (e.g. IndexedDB read) so listNotes/describeSyncStatus can't
  // reject unhandled and leave the screen stuck on "Syncing…".
  try {
    await pullOnOpen(ctx);
    const [notes, statusText] = await Promise.all([listNotes(ctx), describeSyncStatus(ctx)]);
    renderList(app, ctx, notes);
    const statusEl = app.querySelector('#sync-status');
    if (statusEl) statusEl.textContent = statusText;
  } catch (err) {
    showError(app, err);
  }
}

function renderList(app, ctx, notes) {
  const list = app.querySelector('#note-list');
  if (!list) return;
  list.replaceChildren();
  for (const note of notes) {
    list.appendChild(renderNoteRow(app, ctx, note));
  }
}

function renderNoteRow(app, ctx, note) {
  const li = document.createElement('li');
  li.className = 'note-row';

  // note.text is this account's own ciphertext, decrypted client-side — still
  // set via textContent rather than innerHTML as a matter of course on this
  // DEK-holding page.
  const span = document.createElement('span');
  span.textContent = note.text;
  li.appendChild(span);

  const editButton = document.createElement('button');
  editButton.textContent = 'Edit';
  editButton.addEventListener('click', () => {
    const next = prompt('Edit note', note.text);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    updateNote(ctx, note.recordId, trimmed)
      .then(() => refresh(app, ctx))
      .catch((err) => showError(app, err));
  });
  li.appendChild(editButton);

  const deleteButton = document.createElement('button');
  deleteButton.textContent = 'Delete';
  deleteButton.addEventListener('click', () => {
    deleteNote(ctx, note.recordId)
      .then(() => refresh(app, ctx))
      .catch((err) => showError(app, err));
  });
  li.appendChild(deleteButton);

  return li;
}

function showError(app, err) {
  const el = app.querySelector('#notes-error');
  if (el) el.textContent = err.message || String(err);
}
