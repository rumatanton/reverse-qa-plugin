// After the last test: record what the run left behind (rows above the seed, uploaded files, server log), then clean
// it up (new files deleted, database reset to the seed with counts proven). The record goes to
// test-results/<report>-cleanup.json, and run-suites archives it with the run's reports in output/runs/.
// What the plugin cannot reach it cannot clean: for a target with no database or no containers of its own the record
// says so in `not_cleaned`, and never claims a clean-up that did not happen.
// RQA_NO_CLEANUP=1 keeps the data in place for debugging a failure.
import fs from 'node:fs';
import path from 'node:path';
import { target, appService, FRAMEWORK, isDesktop, hasContainers, hasDatabase, hasServerLog } from './target.ts';
import { cleanupLib } from './plugin.ts';

export const MANIFEST = path.join(FRAMEWORK, 'test-results', '.writable-files-before.json');

export default async function globalTeardown() {
  if (process.env.RQA_SKIP_SETUP === '1') return;
  const report = process.env.RQA_REPORT ?? 'adhoc'; // the same name playwright.config.ts gives the run
  const out = path.join(FRAMEWORK, 'test-results', `${report}-cleanup.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  if (process.env.RQA_NO_CLEANUP === '1') {
    fs.writeFileSync(out, `${JSON.stringify({ skipped: 'RQA_NO_CLEANUP=1: test data left in place' }, null, 2)}\n`);
    return;
  }
  if (isDesktop) {
    // nothing is shared between tests: the record says where the app's data went, instead of "not cleaned"
    fs.writeFileSync(out, `${JSON.stringify({ finished: new Date().toISOString(), app_data: 'each test started the app with a data folder of its own, removed when the test ended' }, null, 2)}\n`);
    return;
  }
  const filesBefore = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : [];
  const record = cleanupLib.cleanupTestData(target, appService, { filesBefore, database: hasDatabase, files: hasContainers, log: hasServerLog });
  fs.writeFileSync(out, `${JSON.stringify({ finished: new Date().toISOString(), ...record }, null, 2)}\n`);
  if (record.reset?.mismatches.length) throw new Error(`clean-up could not restore the seed: ${JSON.stringify(record.reset.mismatches)}`);
}
