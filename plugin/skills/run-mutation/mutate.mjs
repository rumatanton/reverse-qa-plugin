#!/usr/bin/env node
// run-mutation: do the passing tests check the right thing? Put one small defect at a time into the running copy of
// the app (a session check turned around, an UPDATE or DELETE that changes nothing), run the tests of the pages it
// touches, and see whether any test changes its result. The source is never touched: the defect goes into the app
// container, and the original file is put back and checked after every mutant.
//   node mutate.mjs --target <name> [--only guards|writes] [--max <n>] [--dry-run] [--gate]
//   exit 0 = ran (with --gate: and nothing survived), 2 = --gate and a mutant survived or had no test, 1 = setup
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { compose, ok } from '../../lib/docker.mjs';
import { readReport, flatten } from '../../lib/pwreport.mjs';
import { parseCsv } from '../../lib/csv.mjs';
import { buildMutants, applyMutant, grepFor, judge, score, mutationMarkdown, relatedFindings } from '../../lib/mutation.mjs';

const OPERATORS = { guards: 'guard-flip', writes: 'write-no-op' };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** The app's copy of a file inside the container: read its hash, or write new content over stdin (no bind mount). */
export function containerFile(target, rel) {
  const service = target.def.runtime.services?.app ?? 'web';
  const at = `${target.def.runtime.app_root.replace(/\/+$/, '')}/${rel}`;
  return {
    hash: () => ok(compose(target, ['exec', '-T', service, 'sha256sum', at]), `sha256sum ${at}`).stdout.trim().split(/\s+/)[0],
    write: (text) => ok(compose(target, ['exec', '-T', service, 'sh', '-c', `cat > '${at.replace(/'/g, "'\\''")}'`], { input: text }), `write ${at}`),
  };
}

/** Run the Chromium tests tagged with these pages. Returns { rows, exit, error }. The report is named `mutation`. */
function runTests(frameworkDir, pages) {
  const report = path.join(frameworkDir, 'test-results', 'mutation.json');
  fs.rmSync(report, { force: true });
  const cli = path.join(frameworkDir, 'node_modules', '@playwright', 'test', 'cli.js');
  const r = spawnSync(process.execPath, [cli, 'test', '--project=chromium', `--grep=${grepFor(pages)}`, '--max-failures=1'], { cwd: frameworkDir, encoding: 'utf8', env: { ...process.env, RQA_REPORT: 'mutation' }, maxBuffer: 64 * 1024 * 1024 });
  const rows = fs.existsSync(report) ? flatten(readReport(report)) : [];
  return { rows, exit: r.status, error: `${r.stderr ?? ''}\n${r.stdout ?? ''}`.split('\n').map((l) => l.trim()).find((l) => /error/i.test(l))?.slice(0, 200) ?? null };
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, only: { type: 'string' }, max: { type: 'string' }, 'dry-run': { type: 'boolean' }, gate: { type: 'boolean' } } });
  if (!values.target || (values.only && !OPERATORS[values.only])) {
    process.stderr.write('usage: mutate.mjs --target <name> [--only guards|writes] [--max <n>] [--dry-run] [--gate]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const out = outputDir(target.dir);
    const inventoryFile = path.join(out, 'inventory.json');
    if (!fs.existsSync(inventoryFile)) throw new Error('no output/inventory.json yet: run scan-repo first');
    const inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
    const source = (rel) => fs.readFileSync(path.join(target.sourceDir, rel), 'utf8');
    let mutants = buildMutants(inventory, source);
    if (values.only) mutants = mutants.filter((m) => m.operator === OPERATORS[values.only]);
    if (values.max) mutants = mutants.slice(0, Number(values.max));

    if (values['dry-run']) {
      for (const m of mutants) process.stdout.write(`${m.id} ${m.operator} ${m.file}:${m.line}  ${m.na ? `not applicable: ${m.na}` : `${m.before}  →  ${m.after}`}  [${m.pages.length} page(s)]\n`);
      process.stdout.write(`run-mutation: ${mutants.length} mutant(s) (${mutants.filter((m) => m.na).length} not applicable); nothing was changed or run\n`);
      return 0;
    }

    const rt = target.def.runtime ?? {};
    if (!rt.compose_file || !rt.app_root) throw new Error('run-mutation needs the app in a container the plugin started: target.yaml runtime.compose_file and runtime.app_root');
    const frameworkDir = path.join(target.dir, 'framework');
    const baselineFile = path.join(frameworkDir, 'test-results', 'report.json');
    if (!fs.existsSync(baselineFile)) throw new Error('no baseline: run the full tier first (run-suites --tier full), so each test has a result without any mutant');
    const baseline = flatten(readReport(baselineFile)).filter((r) => r.project === 'chromium');
    const baselineAt = fs.statSync(baselineFile).mtime.toISOString();

    const results = [];
    const restoreProblems = [];
    let current = null; // { file, original } while a mutant is in place
    const restore = () => {
      if (!current) return;
      const f = containerFile(target, current.file);
      f.write(current.original);
      if (f.hash() !== sha(current.original)) restoreProblems.push(current.file);
      current = null;
    };
    process.on('SIGINT', () => { restore(); process.exit(130); });

    try {
      for (const m of mutants) {
        if (m.na) { results.push({ ...m, state: 'not-applicable', killed_by: [], ran: 0 }); continue; }
        if (m.pages.length === 0) { results.push({ ...m, state: 'no-tests', killed_by: [], ran: 0 }); continue; }
        const original = source(m.file);
        const f = containerFile(target, m.file);
        if (f.hash() !== sha(original)) throw new Error(`${m.file} in the container is not the source's copy; restart the app from a clean image (run-target-app) before mutating`);
        const started = Date.now();
        current = { file: m.file, original };
        f.write(applyMutant(original, m));
        const run = runTests(frameworkDir, m.pages);
        restore();
        const verdict = judge(baseline, run.rows, { setupFailed: run.rows.length === 0 && run.exit !== 0 ? run.error ?? `exit ${run.exit}` : null });
        results.push({ ...m, ...verdict, seconds: Math.round((Date.now() - started) / 1000) });
        process.stdout.write(`run-mutation: ${m.id} ${m.operator} ${m.file}:${m.line}: ${verdict.state}${verdict.killed_by[0] ? ` by ${verdict.killed_by[0]}` : ''} (${verdict.ran} test(s), ${Math.round((Date.now() - started) / 1000)} s)\n`);
      }
    } finally {
      restore();
    }

    // a survivor in a file a known finding names may be code that already does nothing: say which findings
    const findingsFile = path.join(out, 'findings.csv');
    const findings = fs.existsSync(findingsFile) ? parseCsv(fs.readFileSync(findingsFile, 'utf8')) : [];
    const clean = ({ newLine, ...m }) => ({ ...m, findings: relatedFindings(m, findings) });
    const doc = { ran_at: new Date().toISOString(), baseline: { report: 'framework/test-results/report.json', written: baselineAt }, restored: restoreProblems.length === 0, summary: score(results), mutants: results.map(clean) };
    writeOutput(target.dir, 'mutation/mutation.json', `${JSON.stringify(doc, null, 2)}\n`);
    writeOutput(target.dir, 'mutation/mutation.md', mutationMarkdown(doc));
    appendLedger(target.dir, 'run-mutation', { ...doc.summary, restored: doc.restored });
    const s = doc.summary;
    process.stdout.write(`run-mutation: ${s.total} mutant(s): ${s.killed} killed, ${s.survived} survived, ${s.no_tests} with no test, ${s.not_applicable} not applicable; score ${s.score_pct ?? '-'}%; every file put back: ${doc.restored ? 'yes' : `NO (${restoreProblems.join(', ')})`}\n`);
    for (const r of results.filter((x) => x.state === 'survived')) process.stdout.write(`run-mutation:   survived ${r.id} ${r.file}:${r.line} (${r.operator}): ${r.ran} test(s) ran and none changed${relatedFindings(r, findings).length ? `; ${relatedFindings(r, findings).join(' ')} cites this spot` : ''}\n`);
    if (!doc.restored) return 1;
    return values.gate && (s.survived || s.no_tests) ? 2 : 0;
  } catch (err) {
    process.stderr.write(`run-mutation: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
