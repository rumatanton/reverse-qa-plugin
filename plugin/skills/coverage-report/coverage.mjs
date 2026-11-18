#!/usr/bin/env node
// coverage-report: measured coverage, never claimed. Pages (inventory) and role-matrix cells exercised by executed
// tests, requirements with a designed case and with an executed automated test, and P1 requirements automated.
// Every gap is named.
//   node coverage.mjs --target <name> [--report <playwright-report.json>] [--gate]
//   exit 0 = written (and, with --gate, everything at 100%), 2 = --gate and a gap or an unmeasured metric, 1 = error
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { parseCsv } from '../../lib/csv.mjs';
import { readReport, flatten, linkCovers, perfRows } from '../../lib/pwreport.mjs';

const pct = (n, d) => (d === 0 ? null : Math.round((n / d) * 1000) / 10);
const metric = (all, covered) => ({ total: all.length, covered: covered.length, pct: pct(covered.length, all.length), gaps: all.filter((x) => !covered.includes(x)) });

export function defaultReport(target) {
  return path.join(target.dir, 'framework', 'test-results', 'report.json');
}

/**
 * Pure computation from already-loaded inputs (any of them may be null = not available yet). `extraRows` are results
 * outside the main report (other browsers, the visual tier, k6): they count for a case, never for pages or cells.
 */
export function computeCoverage({ inventory, roleMatrix, requirements, cases, risks, rows, extraRows = [] }) {
  const ran = (rows ?? []).filter((r) => r.outcome !== 'skipped');
  const out = { measured: {} };

  if (inventory && rows) {
    const pages = inventory.pages.map((p) => p.path).sort();
    const hit = new Set(ran.flatMap((r) => r.pages));
    out.pages = metric(pages, pages.filter((p) => hit.has(p)));
  }
  if (roleMatrix && rows) {
    const cells = roleMatrix.map((c) => `${c.page}|${c.role}`).sort();
    const hit = new Set(ran.flatMap((r) => r.pages.flatMap((p) => r.roles.map((role) => `${p}|${role}`))));
    out.cells = metric(cells, cells.filter((c) => hit.has(c)));
  }
  if (requirements) {
    const reqIds = requirements.map((r) => r.id).sort();
    const caseReqs = new Map();
    for (const c of cases?.cases ?? []) for (const r of [c.requirement].flat()) caseReqs.set(r, [...(caseReqs.get(r) ?? []), c.id]);
    out.requirements_designed = metric(reqIds, cases ? reqIds.filter((r) => caseReqs.has(r)) : []);
    if (rows && cases) {
      const executedCases = new Set([...ran, ...extraRows.filter((r) => r.outcome !== 'skipped')].flatMap((r) => r.cases));
      const automated = reqIds.filter((r) => (caseReqs.get(r) ?? []).some((id) => executedCases.has(id)));
      out.requirements_automated = metric(reqIds, automated);
      if (risks) {
        const p1 = risks.filter((r) => r.priority === 'P1').map((r) => r.req_id).sort();
        out.p1_automated = metric(p1, p1.filter((r) => automated.includes(r)));
      }
    }
  }
  for (const k of ['pages', 'cells', 'requirements_designed', 'requirements_automated', 'p1_automated']) out.measured[k] = Boolean(out[k]);
  return out;
}

export const OTHER_REPORTS = ['browsers.json', 'visual.json'];

export function loadAll(target, reportFile) {
  const out = outputDir(target.dir);
  const json = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
  const yaml = (f) => (fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, 'utf8')) : null);
  const csv = (f) => (fs.existsSync(f) ? parseCsv(fs.readFileSync(f, 'utf8')) : null);
  const cases = yaml(path.join(out, 'test-cases', 'cases.yaml'));
  const main = fs.existsSync(reportFile) ? flatten(readReport(reportFile)) : null;
  // results kept outside the main report: the other-browser and visual runs beside it, and k6's summary
  const beside = main ? OTHER_REPORTS.map((f) => path.join(path.dirname(reportFile), f)).filter((f) => fs.existsSync(f)).flatMap((f) => flatten(readReport(f))) : [];
  const extra = main ? [...beside, ...perfRows(json(path.join(out, 'perf', 'perf-summary.json')), target.def?.perf?.thresholds)] : [];
  // a case may name the results that automate it (`covers`), since most of them carry no @TC tag
  const linked = linkCovers([...(main ?? []), ...extra], cases?.cases);
  return {
    inventory: json(path.join(out, 'inventory.json')),
    roleMatrix: csv(path.join(out, 'role-matrix.csv')),
    requirements: yaml(path.join(out, 'requirements.yaml')),
    cases,
    risks: csv(path.join(out, 'risk-register.csv')),
    rows: main ? linked.rows.slice(0, main.length) : null,
    extraRows: linked.rows.slice(main?.length ?? 0),
    unmatchedCovers: main ? linked.unmatched : [],
  };
}

const LABELS = { pages: 'pages', cells: 'role-matrix cells', requirements_designed: 'requirements designed', requirements_automated: 'requirements automated', p1_automated: 'P1 automated' };

export function summaryLine(c) {
  const parts = Object.entries(LABELS).map(([k, label]) => (c[k] ? `${label} ${c[k].covered}/${c[k].total} (${c[k].pct ?? '-'}%)` : `${label} not measured`));
  return `coverage-report: ${parts.join(', ')}`;
}

/** Gate: every metric measured and at 100%. Returns the reasons it fails. */
export function gateFailures(c) {
  return Object.entries(LABELS).flatMap(([k, label]) => {
    if (!c[k]) return [`${label}: not measured (input missing)`];
    if (c[k].total > 0 && c[k].covered < c[k].total) return [`${label}: ${c[k].covered}/${c[k].total}, gaps: ${c[k].gaps.slice(0, 10).join(', ')}${c[k].gaps.length > 10 ? ', …' : ''}`];
    return [];
  });
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, report: { type: 'string' }, gate: { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: coverage.mjs --target <name> [--report <playwright-report.json>] [--gate]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const coverage = computeCoverage(loadAll(target, values.report ? path.resolve(values.report) : defaultReport(target)));
    writeOutput(target.dir, 'coverage.json', `${JSON.stringify(coverage, null, 2)}\n`);
    appendLedger(target.dir, 'coverage-report', Object.fromEntries(Object.keys(LABELS).map((k) => [k, coverage[k]?.pct ?? null])));
    process.stdout.write(`${summaryLine(coverage)}\n`);
    if (values.gate) {
      const fails = gateFailures(coverage);
      if (fails.length) {
        process.stderr.write(`coverage gate FAILED:\n${fails.map((f) => `  ${f}`).join('\n')}\n`);
        return 2;
      }
    }
    return 0;
  } catch (err) {
    process.stderr.write(`coverage-report: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
