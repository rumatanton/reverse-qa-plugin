#!/usr/bin/env node
// run-suites: run a target's Playwright tiers in a fixed order and summarize each step. A failing unit, selftest or
// smoke step stops the run: nothing after it would mean anything.
//   node run.mjs --target <name> [--tier all|unit|selftest|smoke|p1|full|browsers|visual] [--upgrade]
//                [--flake-gate --grep <pattern>] [--no-cleanup] [--dry-run]
// After each step the framework's global teardown records, then removes, the test data (rows above the seed, uploaded
// files); this script archives the reports, that record, the PHP log and failure traces in output/runs/.
//   exit 0 = every step passed (documented defects included), 2 = a step failed, 1 = usage or setup problem
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { appendLedger } from '../../lib/ledger.mjs';
import { flatten, outcomeCounts, skipReasons } from '../../lib/pwreport.mjs';
import { capabilities } from '../../lib/platform.mjs';

/** Tiers that need a browser. An API target (target.yaml app.kind: api) has none of them. */
export const BROWSER_TIERS = ['smoke', 'browsers', 'visual'];

/** Tiers a desktop app does not have: its tests start the app itself, so there are no other engines, and no visual tier yet. */
export const NOT_FOR_DESKTOP = ['browsers', 'visual'];

/**
 * Steps for a tier: { name, projects, grep, env, stopOnFail }. kind = the app kind (web or api); driver = its driver
 * (a desktop app built with Electron runs its tiers in the `desktop` project, where each test starts the app).
 */
export function plan(tier, { upgrade = false, flakeGrep = null, repeatEach = 5, kind = 'web', driver = kind } = {}) {
  const prefix = upgrade ? 'upgrade-' : '';
  const desktop = driver === 'electron';
  const main = desktop ? 'desktop' : 'chromium';
  const step = (name, projects, extra = {}) => ({ name, report: `${prefix}${name === 'full' ? 'report' : name}`, projects, grep: null, env: {}, stopOnFail: false, args: [], ...extra });
  const steps = {
    unit: step('unit', ['unit'], { env: { RQA_SKIP_SETUP: '1' }, stopOnFail: true }),
    selftest: step('selftest', ['selftest'], { stopOnFail: true }),
    smoke: step('smoke', [main], { grep: '@smoke', stopOnFail: true }),
    p1: step('p1', [main], { grep: '@p1' }),
    full: step('full', [main]),
    browsers: step('browsers', ['firefox', 'webkit', 'mobile']),
    visual: step('visual', ['visual']),
  };
  if (flakeGrep) return [step('flake', [main], { grep: flakeGrep, args: [`--repeat-each=${repeatEach}`], stopOnFail: true })];
  const names = Object.keys(steps).filter((s) => (kind !== 'api' || !BROWSER_TIERS.includes(s)) && (!desktop || !NOT_FOR_DESKTOP.includes(s)));
  if (tier === 'all') return names.filter((s) => s !== 'p1').map((s) => steps[s]); // every tier this kind of app has: nothing is left out of "all"
  if (!steps[tier]) throw new Error(`unknown tier "${tier}" (all, ${names.join(', ')})`);
  if (!names.includes(tier)) throw new Error(desktop ? `a desktop app has no ${tier} tier: its tests start the app itself (its tiers: all, ${names.join(', ')})` : `the ${tier} tier needs a browser and this target is an API (its tiers: all, ${names.join(', ')})`);
  return [steps[tier]];
}

/** A grep the shell would split or pipe (a space, a |, a bracket) goes in double quotes; a plain tag stays as it is. */
const shellSafe = (g) => (/^[\w@:.\/-]+$/.test(g) ? g : `"${g.replace(/"/g, '\\"')}"`);

export function commandFor(s) {
  return ['npx', 'playwright', 'test', ...s.projects.map((p) => `--project=${p}`), ...(s.grep ? [`--grep=${shellSafe(s.grep)}`] : []), ...s.args].join(' ');
}

/**
 * Keep the run: copy its reports, the clean-up record, the PHP log, the HTML report and the failure artifacts
 * (traces, screenshots, videos) into output/runs/<stamp>-<report>/. test-results/ is overwritten by the next run;
 * this archive is not. Returns the archive folder.
 */
export function archiveRun(targetDirPath, frameworkDir, report, stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')) {
  const dest = path.join(targetDirPath, 'output', 'runs', `${stamp}-${report}`);
  fs.mkdirSync(dest, { recursive: true });
  const results = path.join(frameworkDir, 'test-results');
  for (const [from, to] of [[`${report}.json`, 'report.json'], [`${report}-junit.xml`, 'junit.xml'], [`${report}-cleanup.json`, 'cleanup.json']]) {
    if (fs.existsSync(path.join(results, from))) fs.copyFileSync(path.join(results, from), path.join(dest, to));
  }
  const cleanup = path.join(dest, 'cleanup.json');
  if (fs.existsSync(cleanup)) {
    const log = JSON.parse(fs.readFileSync(cleanup, 'utf8')).php_log;
    if (log) fs.writeFileSync(path.join(dest, 'php-error.log'), log);
  }
  for (const [from, to] of [[path.join(frameworkDir, 'playwright-report'), 'html-report'], [path.join(results, `${report}-artifacts`), 'artifacts']]) {
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dest, to), { recursive: true });
  }
  return dest;
}

/** Counts by outcome and the skip reasons, or null when the step wrote no report. */
function summarize(dir, s) {
  const file = path.join(dir, 'test-results', `${s.report}.json`);
  if (!fs.existsSync(file)) return null;
  const rows = flatten(JSON.parse(fs.readFileSync(file, 'utf8')));
  return { counts: outcomeCounts(rows), skips: skipReasons(rows) };
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { target: { type: 'string' }, root: { type: 'string' }, tier: { type: 'string' }, upgrade: { type: 'boolean' }, 'flake-gate': { type: 'boolean' }, grep: { type: 'string' }, 'repeat-each': { type: 'string' }, 'dry-run': { type: 'boolean' }, 'no-cleanup': { type: 'boolean' } },
  });
  if (!values.target || (values['flake-gate'] && !values.grep)) {
    process.stderr.write('usage: run.mjs --target <name> [--tier all|unit|selftest|smoke|p1|full|browsers|visual] [--upgrade] [--flake-gate --grep <pattern>] [--dry-run]\n');
    return 1;
  }
  let target;
  let steps;
  try {
    target = loadTarget(projectRoot(values.root), values.target);
    steps = plan(values.tier ?? 'all', { upgrade: values.upgrade, flakeGrep: values['flake-gate'] ? values.grep : null, repeatEach: Number(values['repeat-each'] ?? 5), kind: capabilities(target.def).kind, driver: capabilities(target.def).driver });
  } catch (err) {
    process.stderr.write(`run-suites: ${err.message}\n`);
    return 1;
  }
  const dir = path.join(target.dir, 'framework');
  if (values['dry-run']) {
    for (const s of steps) process.stdout.write(`${s.name}: ${commandFor(s)}  [RQA_REPORT=${s.report}${Object.entries(s.env).map(([k, v]) => ` ${k}=${v}`).join('')}${values.upgrade ? ' RQA_UPGRADE=1' : ''}]\n`);
    return 0;
  }
  if (!fs.existsSync(path.join(dir, 'node_modules', '@playwright', 'test'))) {
    process.stderr.write(`run-suites: ${dir} is not installed: run scaffold-framework first\n`);
    return 1;
  }
  let failed = false;
  for (const s of steps) {
    const started = Date.now();
    const env = { ...process.env, RQA_REPORT: s.report, ...(values.upgrade ? { RQA_UPGRADE: '1' } : {}), ...(values['no-cleanup'] ? { RQA_NO_CLEANUP: '1' } : {}), ...s.env };
    const r = spawnSync(commandFor(s), { cwd: dir, shell: true, stdio: 'inherit', env });
    const summary = summarize(dir, s);
    const counts = summary?.counts ?? null;
    const archive = archiveRun(target.dir, dir, s.report);
    const cleanupFile = path.join(archive, 'cleanup.json');
    const cleanup = fs.existsSync(cleanupFile) ? JSON.parse(fs.readFileSync(cleanupFile, 'utf8')) : null;
    // say what was cleaned and, for a target the plugin cannot reach into, what was not: never claim a clean-up that did not happen
    const rows = cleanup?.leftover_rows ? `${Object.values(cleanup.leftover_rows).reduce((a, b) => a + Math.abs(b), 0)} test row(s)` : null;
    const files = cleanup?.removed_files ? `${cleanup.removed_files.length} file(s)` : null;
    const did = [rows, files].filter(Boolean).join(' and ');
    const cleaned = !cleanup ? 'no clean-up (no app needed)' : cleanup.skipped ? 'clean-up skipped (--no-cleanup)' : [did ? `cleaned up ${did}${cleanup.reset ? '; seed restored' : ''}` : null, cleanup.not_cleaned ? `not cleaned: ${cleanup.not_cleaned}` : null, cleanup.app_data ?? null].filter(Boolean).join('; ');
    const line = counts ? Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ') : 'no report written';
    process.stdout.write(`run-suites: ${s.name}: exit ${r.status} in ${((Date.now() - started) / 1000).toFixed(1)} s (${line}); ${cleaned}; recorded in ${path.relative(target.dir, archive)}\n`);
    // a skip is not a pass: say what each group of skipped tests is waiting for
    for (const k of summary?.skips ?? []) process.stdout.write(`run-suites:   skipped ${k.count}: ${k.reason}\n`);
    appendLedger(target.dir, 'run-suites', { step: s.name, upgrade: Boolean(values.upgrade), exit: r.status, counts, skips: summary?.skips ?? [], ms: Date.now() - started, archive: path.relative(target.dir, archive), leftover_rows: cleanup?.leftover_rows ?? null, removed_files: cleanup?.removed_files?.length ?? null });
    if (r.status !== 0) {
      failed = true;
      if (s.stopOnFail) {
        process.stdout.write(`run-suites: stopping: ${s.name} failed, so later steps would not mean anything. Run triage-failures next.\n`);
        break;
      }
    }
  }
  return failed ? 2 : 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
