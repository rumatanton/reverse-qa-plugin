#!/usr/bin/env node
// rerun: every check against a target that already went through recon, in one command, with nothing left out.
//   plugin tests → every Playwright tier (run-suites --tier all) → PHP upgrade copy → security scans → k6 smoke and
//   load → triage (+ finding confirmation) → coverage → report and dashboard data.
// A failing step is recorded and the next one still runs, so one run shows every result. Model calls: none.
//   node rerun.mjs --target <name> [--root <project>] [--skip-plugin-tests] [--skip-upgrade] [--dry-run]
//   exit 0 = every step passed, 2 = a step failed (see the summary), 1 = usage
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { appendLedger } from '../../lib/ledger.mjs';

const PLUGIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const skill = (name, file) => path.join(PLUGIN, 'skills', name, file);

/** The steps, in order: { name, cmd, args, cwd? }. */
export function steps(target, { root, plugin = true, upgrade = true } = {}) {
  const t = ['--target', target.name, ...(root ? ['--root', root] : [])];
  const node = (name, file, extra = []) => ({ name, cmd: process.execPath, args: [skill(name, file), ...t, ...extra] });
  const list = [];
  if (plugin) list.push({ name: 'plugin tests', cmd: 'npm', args: ['run', '--silent', 'test:report'], cwd: PLUGIN, shell: true });
  list.push(node('run-suites', 'run.mjs', ['--tier', 'all']));
  if (upgrade && target.def.runtime?.upgrade_base_url) {
    list.push(node('run-target-app', 'run.mjs', ['--upgrade', '--no-reset']));
    list.push(node('run-upgrade-compare', 'compare.mjs', ['--run']));
  }
  list.push(node('run-security-scans', 'security.mjs'));
  list.push({ ...node('run-perf', 'perf.mjs', ['--scenario', 'smoke']), name: 'run-perf smoke' });
  list.push({ ...node('run-perf', 'perf.mjs', ['--scenario', 'load', '--vus', '10', '--duration', '2m']), name: 'run-perf load' });
  list.push(node('triage-failures', 'triage.mjs', ['--confirm-findings']));
  list.push(node('build-stories', 'stories.mjs')); // refreshes stories from the requirements, keeps final wording
  list.push(node('coverage-report', 'coverage.mjs'));
  list.push(node('build-report', 'report.mjs', ['--dashboard']));
  return list;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, 'skip-plugin-tests': { type: 'boolean' }, 'skip-upgrade': { type: 'boolean' }, 'dry-run': { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: rerun.mjs --target <name> [--root <project>] [--skip-plugin-tests] [--skip-upgrade] [--dry-run]\n');
    return 1;
  }
  let target;
  try {
    target = loadTarget(projectRoot(values.root), values.target);
  } catch (err) {
    process.stderr.write(`rerun: ${err.message}\n`);
    return 1;
  }
  const list = steps(target, { root: values.root, plugin: !values['skip-plugin-tests'], upgrade: !values['skip-upgrade'] });
  if (values['dry-run']) {
    for (const s of list) process.stdout.write(`${s.name}: ${[s.cmd === process.execPath ? 'node' : s.cmd, ...s.args.map((a) => (a.startsWith(PLUGIN) ? path.relative(PLUGIN, a) : a))].join(' ')}\n`);
    return 0;
  }
  const results = [];
  for (const s of list) {
    process.stdout.write(`\nrerun: ── ${s.name} ──\n`);
    const started = Date.now();
    const r = spawnSync(s.cmd, s.args, { cwd: s.cwd ?? projectRoot(values.root), stdio: 'inherit', shell: s.shell ?? false });
    results.push({ step: s.name, exit: r.status, s: Math.round((Date.now() - started) / 1000) });
  }
  process.stdout.write('\nrerun: summary\n');
  for (const r of results) process.stdout.write(`rerun:   ${r.exit === 0 ? 'ok    ' : `exit ${r.exit}`}  ${r.step} (${r.s} s)\n`);
  const failed = results.filter((r) => r.exit !== 0);
  process.stdout.write(`rerun: ${results.length - failed.length}/${results.length} steps passed; the dashboard data is in targets/${target.name}/output/dashboard/\n`);
  appendLedger(target.dir, 'rerun', { steps: results });
  return failed.length ? 2 : 0;
}

if (fs.existsSync(process.argv[1] ?? '') && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
