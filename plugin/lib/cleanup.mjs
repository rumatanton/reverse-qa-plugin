// Test-data clean-up after a run, with a record of what was cleaned. Before the run: list the files already in the
// app's writable folders. After the run: count what the tests left (rows per table above the seed, new files, server log),
// delete the new files, reset the database to the seed (counts proven), and return the record for the run archive.
import { compose, ok } from './docker.mjs';
import { counts } from './db.mjs';
import { serverLog, truncateServerLog } from './runtime.mjs';
import { resetDatabase, seedSql } from '../skills/db-reset/reset.mjs';
import { parseDump, rowCounts } from './sqldump.mjs';

function appPaths(target) {
  const r = target.def.runtime ?? {};
  const root = (r.app_root ?? '/var/www/html').replace(/\/+$/, '');
  return (r.writable_dirs ?? []).map((d) => `${root}/${d.replace(/^\/+|\/+$/g, '')}`);
}

/** Every file in the app's writable folders, as container paths, sorted. */
export function listWritableFiles(target, service) {
  const dirs = appPaths(target);
  if (dirs.length === 0) return [];
  const r = ok(compose(target, ['exec', '-T', service, 'sh', '-c', `for d in ${dirs.map((d) => `'${d}'`).join(' ')}; do [ -d "$d" ] && find "$d" -type f; done; true`]), 'list writable files');
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).sort();
}

/** Files present now that were not in `before`. */
export function newFiles(before, now) {
  const had = new Set(before);
  return now.filter((f) => !had.has(f));
}

/** Rows each table holds above (or below) the seed. Tables at their seed count are left out. */
export function leftoverRows(seed, live) {
  const out = {};
  for (const t of [...new Set([...Object.keys(seed), ...Object.keys(live)])].sort()) {
    const d = (live[t] ?? 0) - (seed[t] ?? 0);
    if (d !== 0) out[t] = d;
  }
  return out;
}

/**
 * Clean up after a run. Returns the record: { leftover_rows, removed_files, php_log, reset, not_cleaned? }.
 * The record is written by the caller before anything else can overwrite it.
 * `database`, `files` and `log` say what the plugin can reach for this target (all true for an app it started with a
 * database). What it cannot reach it does not clean, and the record says so in `not_cleaned`: `leftover_rows`,
 * `removed_files` or `reset` are then null, never an empty result that would read as "nothing was left".
 */
export function cleanupTestData(target, service, { filesBefore = [], database = true, files = true, log = true } = {}) {
  const record = { leftover_rows: null, removed_files: null, php_log: log ? serverLog(target, service) : '', reset: null };
  const notCleaned = [];
  if (database) {
    const seed = rowCounts(parseDump(seedSql(target).join('\n;\n')));
    record.leftover_rows = leftoverRows(seed, counts(target));
  } else notCleaned.push('no database the plugin can reach, so rows the tests added stay in the app');
  if (files) {
    record.removed_files = newFiles(filesBefore, listWritableFiles(target, service));
    for (let i = 0; i < record.removed_files.length; i += 50) {
      ok(compose(target, ['exec', '-T', service, 'rm', '-f', '--', ...record.removed_files.slice(i, i + 50)]), 'remove test files'); // argv, no shell
    }
  } else notCleaned.push('the app does not run in containers the plugin started, so files the tests uploaded stay in the app');
  if (database) {
    const r = resetDatabase(target);
    record.reset = { tables: r.tables, rows: r.rows, mismatches: r.mismatches };
  }
  if (log) truncateServerLog(target, service);
  if (notCleaned.length) record.not_cleaned = notCleaned.join('; ');
  return record;
}
