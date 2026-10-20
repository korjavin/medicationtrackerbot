// The one guard for every due-dose writer (bd med-o7zq.41): the shim's sweep
// (apishim.js) and the inbox appliers (inbox-apply.js) all run their
// materialization through materializing(). A writer reads the store's
// medications first and writes their doses afterwards, so a replace or wipe
// that lands in between would get intakes of a medication it does not have.
// withMaterializationStopped holds every writer off for the replace and
// waits out the ones already running.
let paused = 0; // a count, so two overlapping replaces both hold it
let inFlight = Promise.resolve();

export class MaterializationPausedError extends Error {
  constructor() {
    super('Dose materialization is paused while the records are replaced.');
    this.name = 'MaterializationPausedError';
  }
}

// Runs fn as a tracked writer. While paused it rejects without running: an
// inbox event then stays queued and is applied after the replace.
export function materializing(fn) {
  if (paused) return Promise.reject(new MaterializationPausedError());
  const run = Promise.resolve().then(fn);
  inFlight = Promise.all([inFlight, run.catch(() => {})]).then(() => {});
  return run;
}

// Every writer started so far, settled. Tests await it before dropping a store.
export function materializationSettled() {
  return inFlight;
}

// Runs fn (a store replace or wipe) with no writer running or starting. The
// pause ends however fn ends: a writer after it reads the new store, which is
// correct whether the page reloads or not.
export async function withMaterializationStopped(fn) {
  paused++;
  try {
    await inFlight;
    return await fn();
  } finally {
    paused--;
  }
}
