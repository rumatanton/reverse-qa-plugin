#!/usr/bin/env node
// run-upgrade-compare: the same suite on the default version and on the upgrade (e.g. PHP 7.2 vs 8.2), compared test by
// test, plus how the PHP log changed. Writes output/upgrade/upgrade-diff.json (read by build-report) and .md.
//   node compare.mjs --target <name> [--run]     --run first runs `run-suites --tier full` on both versions
//   exit 0 = written (differences are results, not errors), 1 = usage or a report is missing
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { flatten } from '../../lib/pwreport.mjs';
import { classifyServerLog, logPatterns } from '../../lib/runtime.mjs';

const RUN_SUITES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'run-suites', 'run.mjs');
const key = (r) => `${r.project} › ${r.file} › ${r.title}`;

/** The informative line of an error: the PHP fatal itself rather than the framework watcher's header line. */
export function firstError(error) {
  if (!error) return null;
  const lines = error.split('\n').map((l) => l.trim()).filter(Boolean);
  const php = lines.find((l) => /PHP (Fatal|Parse) error:/i.test(l));
  return (php ?? lines[0]).replace(/^\[[^\]]+\]\s*/, '').slice(0, 220);
}

/** Compare two flattened runs: same outcome, different outcome, and tests only one side ran. */
export function diffRuns(before, after) {
  const a = new Map(before.map((r) => [key(r), r]));
  const b = new Map(after.map((r) => [key(r), r]));
  const different = [];
  let same = 0;
  for (const [k, r] of a) {
    const s = b.get(k);
    if (!s) continue;
    if (s.outcome === r.outcome) same++;
    else different.push({ title: r.title, file: r.file, project: r.project, before: r.outcome, after: s.outcome, error_after: firstError(s.error) });
  }
  return {
    same,
    different: different.sort((x, y) => x.title.localeCompare(y.title)),
    only_before: [...a.keys()].filter((k) => !b.has(k)).sort(),
    only_after: [...b.keys()].filter((k) => !a.has(k)).sort(),
  };
}

// server log lines per class (fatal, warning, …), by the target's own patterns: PHP's for a PHP app, the generic ones otherwise
const logCounts = (text, def = {}) => Object.fromEntries(Object.entries(classifyServerLog(text ?? '', logPatterns(def))).map(([k, v]) => [k, v.length]));

export function compareMarkdown(d) {
  const lines = [`# Upgrade comparison: ${d.before_label} → ${d.after_label}`, '', `${d.same} test(s) behave the same; ${d.different.length} differ; ${d.only_before.length} ran only before, ${d.only_after.length} only after.`, ''];
  if (d.different.length) lines.push('| Test | Before | After | First error after |', '|---|---|---|---|', ...d.different.map((x) => `| ${x.title} | ${x.before} | ${x.after} | ${x.error_after ?? ''} |`), '');
  lines.push('## PHP log during the run', '', '| Level | Before | After |', '|---|---|---|', ...Object.keys(d.php_log.before).map((k) => `| ${k} | ${d.php_log.before[k]} | ${d.php_log.after[k]} |`));
  return `${lines.join('\n')}\n`;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, run: { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: compare.mjs --target <name> [--run]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const root = projectRoot(values.root);
    if (values.run) {
      for (const extra of [[], ['--upgrade']]) {
        spawnSync(process.execPath, [RUN_SUITES, '--target', target.name, '--root', root, '--tier', 'full', ...extra], { stdio: 'inherit' });
      }
    }
    const results = path.join(target.dir, 'framework', 'test-results');
    const read = (name) => {
      const f = path.join(results, name);
      if (!fs.existsSync(f)) throw new Error(`${f} not found: run with --run, or run-suites --tier full with and without --upgrade`);
      return JSON.parse(fs.readFileSync(f, 'utf8'));
    };
    const cleanupLog = (name) => (fs.existsSync(path.join(results, name)) ? JSON.parse(fs.readFileSync(path.join(results, name), 'utf8')).php_log ?? '' : '');
    const d = {
      before_label: target.def.runtime?.services?.app ?? 'default',
      after_label: target.def.runtime?.services?.app_upgrade ?? 'upgrade',
      ...diffRuns(flatten(read('report.json')), flatten(read('upgrade-report.json'))),
      php_log: { before: logCounts(cleanupLog('report-cleanup.json'), target.def), after: logCounts(cleanupLog('upgrade-report-cleanup.json'), target.def) },
    };
    writeOutput(target.dir, 'upgrade/upgrade-diff.json', `${JSON.stringify(d, null, 2)}\n`);
    writeOutput(target.dir, 'upgrade/upgrade-diff.md', compareMarkdown(d));
    appendLedger(target.dir, 'run-upgrade-compare', { same: d.same, different: d.different.length, php_log: d.php_log });
    process.stdout.write(`run-upgrade-compare: ${d.same} same, ${d.different.length} different, ${d.only_before.length} only before, ${d.only_after.length} only after; PHP log warnings ${d.php_log.before.warning} → ${d.php_log.after.warning}, deprecations ${d.php_log.before.deprecated} → ${d.php_log.after.deprecated}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`run-upgrade-compare: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
