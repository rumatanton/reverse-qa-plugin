#!/usr/bin/env node
// build-rtm: the requirements traceability matrix. One row per requirement × test case:
// risk → requirement → test case → automated specs → last result → Xray key → findings. Orphans in either direction
// (a requirement with no case, a case or spec pointing at nothing) are listed, never hidden.
//   node rtm.mjs --target <name> [--report <playwright-report.json>] [--strict]
//   exit 0 = written (and no orphans with --strict), 2 = --strict and orphans exist, 1 = error
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { toCsv, parseCsv } from '../../lib/csv.mjs';
import YAML from 'yaml';
import { loadAll, defaultReport } from '../coverage-report/coverage.mjs';

export const COLUMNS = ['story', 'req_id', 'requirement', 'kind', 'risk_score', 'priority', 'case_id', 'case_title', 'case_type', 'xray_key', 'automated_by', 'last_result', 'findings'];
const RANK = { failed: 5, 'fixed-defect': 4, 'known-defect': 3, flaky: 2, passed: 1, skipped: 0 };

/** The results behind a case, readable in one cell: the first few by name, then how many more. */
function automatedBy(runs) {
  const names = [...new Set(runs.map((x) => `${x.file}: ${x.title}${['default', 'chromium', 'k6'].includes(x.project) ? '' : ` [${x.project}]`}`))];
  return names.length > 3 ? `${names.slice(0, 3).join(' | ')} | and ${names.length - 3} more` : names.join(' | ');
}

/** Worst outcome across a case's runs (any failure shows). */
function worst(outcomes) {
  return outcomes.length ? outcomes.reduce((a, b) => (RANK[b] > RANK[a] ? b : a)) : 'not run';
}

export function buildRtm({ requirements, cases, risks, rows, extraRows = [], unmatchedCovers = [], xrayKeys = {}, findings = [], stories = [] }) {
  const storyOf = new Map((stories ?? []).flatMap((s) => [...(s.requirements ?? []), ...(s.replaces ?? [])].map((id) => [id, s.id])));
  const reqs = requirements ?? [];
  const reqIds = new Set(reqs.map((r) => r.id));
  const caseList = cases?.cases ?? [];
  const caseIds = new Set(caseList.map((c) => c.id));
  const risk = new Map((risks ?? []).map((r) => [r.req_id, r]));
  const runsByCase = new Map();
  for (const r of [...(rows ?? []), ...extraRows]) for (const id of r.cases) runsByCase.set(id, [...(runsByCase.get(id) ?? []), r]);
  const findingsByReq = new Map();
  for (const f of findings) if (f.req_id) findingsByReq.set(f.req_id, [...(findingsByReq.get(f.req_id) ?? []), f.id]);

  const out = [];
  for (const r of reqs) {
    const linked = caseList.filter((c) => [c.requirement].flat().includes(r.id));
    const base = { story: storyOf.get(r.id) ?? '', req_id: r.id, requirement: r.statement, kind: r.kind, risk_score: risk.get(r.id)?.score ?? '', priority: risk.get(r.id)?.priority ?? '', findings: (findingsByReq.get(r.id) ?? []).join(' ') };
    if (linked.length === 0) out.push({ ...base, case_id: '', last_result: 'no test case' });
    for (const c of linked) {
      const runs = runsByCase.get(c.id) ?? [];
      out.push({
        ...base,
        case_id: c.id,
        case_title: c.title,
        case_type: c.type,
        xray_key: xrayKeys[c.id] ?? '',
        automated_by: automatedBy(runs),
        last_result: worst(runs.filter((x) => x.outcome !== 'skipped').map((x) => x.outcome)),
      });
    }
  }
  const orphans = {
    requirements_without_cases: reqs.filter((r) => !caseList.some((c) => [c.requirement].flat().includes(r.id))).map((r) => r.id),
    cases_without_requirement: caseList.filter((c) => ![c.requirement].flat().some((x) => reqIds.has(x))).map((c) => c.id),
    specs_with_unknown_case: [...new Set((rows ?? []).flatMap((r) => r.cases.filter((id) => !caseIds.has(id)).map((id) => `${id} (${r.file}: ${r.title})`)))],
    cases_never_automated: caseList.filter((c) => !runsByCase.has(c.id)).map((c) => c.id),
    // a `covers` selector that selected no result that ran: the case names coverage it does not have
    covers_matching_nothing: unmatchedCovers.map((u) => `${u.case}: ${u.selector}`),
  };
  return { rows: out, orphans };
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, report: { type: 'string' }, strict: { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: rtm.mjs --target <name> [--report <playwright-report.json>] [--strict]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    const inputs = loadAll(target, values.report ? path.resolve(values.report) : defaultReport(target));
    if (!inputs.requirements) throw new Error('no output/requirements.yaml yet');
    const out = outputDir(target.dir);
    const keysFile = path.join(out, 'xray', 'xray-keys.json');
    const findingsFile = path.join(out, 'findings.csv');
    const storiesFile = path.join(out, 'stories.yaml');
    const rtm = buildRtm({
      ...inputs,
      xrayKeys: fs.existsSync(keysFile) ? JSON.parse(fs.readFileSync(keysFile, 'utf8')) : {},
      findings: fs.existsSync(findingsFile) ? parseCsv(fs.readFileSync(findingsFile, 'utf8')) : [],
      stories: fs.existsSync(storiesFile) ? YAML.parse(fs.readFileSync(storiesFile, 'utf8')) ?? [] : [],
    });
    writeOutput(target.dir, 'rtm.csv', toCsv(rtm.rows, COLUMNS));
    writeOutput(target.dir, 'rtm-orphans.json', `${JSON.stringify(rtm.orphans, null, 2)}\n`);
    const o = rtm.orphans;
    appendLedger(target.dir, 'build-rtm', { rows: rtm.rows.length, orphans: Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.length])) });
    process.stdout.write(`build-rtm: ${rtm.rows.length} rows; orphans: ${o.requirements_without_cases.length} requirement(s) without a case, ${o.cases_without_requirement.length} case(s) without a requirement, ${o.specs_with_unknown_case.length} spec tag(s) naming an unknown case, ${o.covers_matching_nothing.length} "covers" selector(s) matching no result; ${o.cases_never_automated.length} case(s) not automated yet\n`);
    const hard = o.requirements_without_cases.length + o.cases_without_requirement.length + o.specs_with_unknown_case.length + o.covers_matching_nothing.length;
    return values.strict && hard ? 2 : 0;
  } catch (err) {
    process.stderr.write(`build-rtm: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
