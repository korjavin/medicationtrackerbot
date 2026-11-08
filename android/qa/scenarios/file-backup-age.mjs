// Standalone variant: run file-backup, export an encrypted .age file, save and pick it
// through native DocumentsUI, decrypt and replace, and compare the restored full fixture.
import fileBackup, { retry } from './file-backup.mjs';
export { retry };
export default fileBackup;
