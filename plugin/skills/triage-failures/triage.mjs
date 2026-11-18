#!/usr/bin/env node
// triage-failures: root-cause triage of a test run. Each failing test is labelled from evidence, with the line that
// decided it:
//   environment   the run could not reach the app or start a browser (not a result at all)
//   app           the server failed: PHP fatal / uncaught error in the test's time window, or an HTTP 5xx
//   test          the test itself: locator not found or ambiguous, element state, script error
//   needs-review  an assertion mismatch with no server-side evidence: a person decides (product bug or wrong expectation)
//   app-changed   a test.fail() (documented defect) passed: the defect may be fixed; confirm, then close the finding
// Flaky passes are reported separately.
//   node triage.mjs --target <name> [--report <playwright-report.json>] [--php-log <file>]
//   exit 0 = written, 1 = usage or no report
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { readReport, flatten } from '../../lib/pwreport.mjs';
import { parseCsv, toCsv } from '../../lib/csv.mjs';
import { serverLog, appVariant } from '../../lib/runtime.mjs';
import { dockerAvailable } from '../../lib/docker.mjs';
import { defaultReport } from '../coverage-report/coverage.mjs';

const ENV = /ECONNREFUSED|ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|getaddrinfo|socket hang up|Executable doesn't exist|browserType\.launch|Timed out waiting \d+ms from config\.webServer/i;
const HTTP_5XX = /\b(5\d\d)\b(?=[^\n]*(Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|status))|Received:\s*5\d\d|status(?:\s+code)?\s*(?:of\s+)?5\d\d/i;
const TEST = /strict mode violation|resolved to \d+ elements|waiting for (locator|getBy\w+)|locator\.\w+: Timeout|element is not (attached|visible|enabled|stable|editable)|Target closed|is not a function|ReferenceError|TypeError: Cannot read/i;
const ASSERTION = /expect\(.*\)\.(to\w+)|Expected:|Received:/;

/** Parse "[09-Nov-2026 21:30:29 UTC] PHP Fatal error: …" lines into { at, line, level }. */
export function parsePhpLog(text) {
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      const m = line.match(/^\[(\d{2})-(\w{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})(?: (\w+))?\]/);
      const at = m ? Date.UTC(+m[3], months[m[2]], +m[1], +m[4], +m[5], +m[6]) : null;
      const level = /Fatal error|Parse error|Uncaught/i.test(line) ? 'fatal' : /Warning/i.test(line) ? 'warning' : /Notice/i.test(line) ? 'notice' : 'other';
      return { at, line: line.replace(/^\[[^\]]+\]\s*/, ''), level };
    });
}

/** Log entries inside a test's window (1 s before start to 2 s after it ends). */
export function inWindow(entries, row) {
  if (!row.startTime) return [];
  const start = new Date(row.startTime).getTime() - 1000;
  const end = new Date(row.startTime).getTime() + (row.duration ?? 0) + 2000;
  return entries.filter((e) => e.at !== null && e.at >= start && e.at <= end);
}

const NEXT = {
  environment: 'Fix the environment and run again; this run is not a result.',
  app: 'Write or update a finding (F-…) with its root cause; mark the test test.fail() with the finding ID only after a person confirms.',
  test: 'Repair the test (Playwright healer, at most 3 rounds), then rerun with --repeat-each=5.',
  'needs-review': 'A person decides: product bug (finding) or wrong expectation (fix the test or the requirement).',
  'app-changed': 'The documented defect may be fixed: confirm, remove test.fail(), and close the finding.',
};

export function classify(row, logEntries = []) {
  const err = row.error ?? '';
  const window = inWindow(logEntries, row);
  const fatal = window.filter((e) => e.level === 'fatal');
  const warnings = window.filter((e) => e.level === 'warning');
  const first = (re) => err.split('\n').find((l) => re.test(l))?.trim().slice(0, 300) ?? err.split('\n')[0].slice(0, 300);
  const matching = (re) => {
    const hits = err.split('\n').filter((l) => re.test(l)).map((l) => l.trim().slice(0, 300));
    return hits.length ? hits.slice(0, 3) : [first(re)];
  };
  let category;
  let confidence = 'high';
  let evidence;
  if (row.outcome === 'fixed-defect') [category, evidence] = ['app-changed', ['test.fail() passed: the app no longer shows the documented defect']];
  else if (ENV.test(err) || window.some((e) => /mysqli.*(Connection refused|No such file or directory|Access denied)/i.test(e.line))) {
    category = 'environment';
    evidence = [ENV.test(err) ? first(ENV) : window.find((e) => /mysqli/i.test(e.line)).line];
  } else if (fatal.length) [category, evidence] = ['app', fatal.map((e) => `PHP log: ${e.line}`)];
  else if (/PHP fatal error during the test|PHP (Fatal|Parse) error/i.test(err)) [category, evidence] = ['app', matching(/PHP (Fatal|Parse) error:/i)]; // the framework's PHP-log watcher (its header line has no colon)
  else if (/Server error during the test:/.test(err)) {
    // the framework's server-log watcher on a stack other than PHP: the logged lines follow its header line
    const lines = err.split('\n');
    const at = lines.findIndex((l) => /Server error during the test:/.test(l));
    [category, evidence] = ['app', lines.slice(at + 1, at + 4).map((l) => l.trim().slice(0, 300)).filter(Boolean)];
    if (!evidence.length) evidence = [lines[at].trim()];
  } else if (HTTP_5XX.test(err)) [category, evidence] = ['app', [first(HTTP_5XX)]];
  else if (TEST.test(err)) [category, evidence] = ['test', matching(TEST)];
  else if (ASSERTION.test(err) && warnings.length) {
    [category, confidence, evidence] = ['app', 'medium', [first(ASSERTION), ...warnings.map((e) => `PHP log: ${e.line}`)]];
  } else [category, confidence, evidence] = ['needs-review', 'low', [err ? first(ASSERTION) : 'no error message recorded']];
  return { file: row.file, title: row.title, project: row.project, outcome: row.outcome, category, confidence, evidence, next: NEXT[category], findings: row.findings, cases: row.cases };
}

/** The PHP log archived with the newest run in output/runs/ ('' when there is none). */
export function latestArchivedLog(target) {
  const runs = path.join(target.dir, 'output', 'runs');
  if (!fs.existsSync(runs)) return '';
  const newest = fs.readdirSync(runs).filter((d) => fs.existsSync(path.join(runs, d, 'php-error.log'))).sort().at(-1);
  return newest ? fs.readFileSync(path.join(runs, newest, 'php-error.log'), 'utf8') : '';
}

export function triage(rows, logEntries) {
  const items = rows.filter((r) => r.outcome === 'failed' || r.outcome === 'fixed-defect').map((r) => classify(r, logEntries));
  const summary = { environment: 0, app: 0, test: 0, 'needs-review': 0, 'app-changed': 0 };
  for (const i of items) summary[i.category]++;
  const flaky = rows.filter((r) => r.outcome === 'flaky').map((r) => ({ file: r.file, title: r.title, project: r.project }));
  return { summary, items, flaky };
}

export function triageMarkdown(t) {
  const lines = ['# Failure triage', '', `| Category | Count |`, '|---|---|', ...Object.entries(t.summary).map(([k, v]) => `| ${k} | ${v} |`), `| flaky (passed on retry) | ${t.flaky.length} |`, ''];
  for (const i of t.items) {
    lines.push(`## ${i.category}: ${i.title}`, '', `- ${i.file} · ${i.project} · confidence ${i.confidence}`, ...i.evidence.map((e) => `- evidence: \`${e.replace(/`/g, "'")}\``), `- next: ${i.next}`, '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

/**
 * A finding is confirmed when a test reproduces it: a test tagged with its ID (F-NNN) that is a test.fail(), failed as
 * expected ("known-defect"), and failed at the assertion that names the finding (its message starts "F-NNN:"). A
 * known-defect test that failed anywhere else (a precondition, a fixture, a timeout) proves nothing about the finding:
 * it is listed in `unproven` and confirms nothing. Marks confirmed findings `confirmed` and records the test in
 * `test_id`; never touches a rejected finding. Returns { findings, confirmed: [ids newly confirmed], unproven }.
 */
export function confirmFindings(findings, rows) {
  const tests = new Map();
  const unproven = [];
  for (const r of rows) {
    if (r.outcome !== 'known-defect') continue;
    const name = `${r.file}: ${r.title.replace(/\s+@\S+/g, '').replace(/\s+F-\d{3}\b/g, '').trim()}`;
    for (const id of r.findings) {
      if ((r.error ?? '').includes(`${id}:`)) tests.set(id, [...(tests.get(id) ?? []), name]);
      else unproven.push({ id, test: name, error: (r.error ?? 'no error recorded').split('\n')[0] });
    }
  }
  const confirmed = [];
  const out = findings.map((f) => {
    const t = tests.get(f.id);
    if (!t || f.status === 'rejected') return f;
    if (f.status !== 'confirmed') confirmed.push(f.id);
    const ids = [...new Set([...(f.test_id ? f.test_id.split('; ') : []), ...t])];
    return { ...f, status: 'confirmed', test_id: ids.join('; ') };
  });
  return { findings: out, confirmed, unproven };
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, report: { type: 'string' }, 'php-log': { type: 'string' }, 'confirm-findings': { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: triage.mjs --target <name> [--report <playwright-report.json>] [--php-log <file>] [--confirm-findings]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const reportFile = values.report ? path.resolve(values.report) : defaultReport(target);
    if (!fs.existsSync(reportFile)) throw new Error(`no Playwright report at ${reportFile} (run-suites writes it)`);
    let logText = '';
    if (values['php-log']) logText = fs.readFileSync(values['php-log'], 'utf8');
    else if ((logText = latestArchivedLog(target))) {
      // the run's clean-up empties the live log; run-suites archived it first
    } else if (target.def.runtime?.compose_file && dockerAvailable()) logText = serverLog(target, appVariant(target.def).service);
    const rows = flatten(readReport(reportFile));
    const t = triage(rows, parsePhpLog(logText));
    const findingsFile = path.join(target.dir, 'output', 'findings.csv');
    if (values['confirm-findings'] && fs.existsSync(findingsFile)) {
      const before = parseCsv(fs.readFileSync(findingsFile, 'utf8'));
      const c = confirmFindings(before, rows);
      if (before.length) writeOutput(target.dir, 'findings.csv', toCsv(c.findings, Object.keys(before[0]).includes('test_id') ? Object.keys(before[0]) : [...Object.keys(before[0]), 'test_id']));
      appendLedger(target.dir, 'confirm-findings', { confirmed: c.confirmed, unproven: c.unproven });
      process.stdout.write(`triage-failures: ${c.confirmed.length} finding(s) newly confirmed by a reproducing test${c.confirmed.length ? `: ${c.confirmed.join(', ')}` : ''}\n`);
      for (const u of c.unproven) process.stdout.write(`triage-failures: ${u.id} not confirmed by "${u.test}": it failed before the assertion naming the finding (${u.error})\n`);
    }
    writeOutput(target.dir, 'triage.json', `${JSON.stringify(t, null, 2)}\n`);
    writeOutput(target.dir, 'triage.md', triageMarkdown(t));
    appendLedger(target.dir, 'triage-failures', { summary: t.summary, flaky: t.flaky.length });
    process.stdout.write(`triage-failures: ${t.items.length} failing test(s): ${Object.entries(t.summary).map(([k, v]) => `${k} ${v}`).join(', ')}; flaky ${t.flaky.length}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`triage-failures: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
