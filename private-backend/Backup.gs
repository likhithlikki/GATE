/**
 * Backups are NOT implemented in this project (Task 41).
 *
 * This project is a web app (see AuthRouter.gs) and deliberately holds no Drive permission. The owner-only backup lives in the separate
 * Apps Script project in the repository folder private-backup/, which declares the Drive scope in its own appsscript.json.
 *
 * This stub exists only so that running the old name from the editor gives a clear answer instead of a missing-function error. It does no
 * work, touches no service, is not routed (no AuthRouter, doGet or doPost entry) and creates nothing.
 */
function admin_backup_private_databases() {
  Logger.log('Backups are not available in this project. Use the separate private-backup Apps Script project.');
  return { ok: false, code: 'backup_not_available_in_this_project', atomic_snapshot: false };
}
