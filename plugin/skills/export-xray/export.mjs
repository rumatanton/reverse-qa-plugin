#!/usr/bin/env node
// export-xray: render the canonical test cases (output/test-cases/cases.yaml) into everything Xray reads, offline:
// xray/xray-tests.json (Cloud bulk import), xray/xray-import.csv (Test Case Importer), test-cases/features/*.feature.
// With --results, turn a Playwright JSON report into xray/xray-results.json (Xray JSON execution results).
//   node export.mjs --target <name> [--results <playwright-report.json>]
//   exit 0 = written, 2 = the cases break the schema or leave a requirement uncovered, 1 = usage or configuration
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { validateCases, validateBulkTests, toBulk, toFeatures, toImporterCsv, toXrayResults } from '../../lib/xray.mjs';
import { approvedRequirementIds } from '../../lib/review.mjs';

const readYaml = (file) => (fs.existsSync(file) ? YAML.parse(fs.readFileSync(file, 'utf8')) : null);
const readJson = (file) => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null);

export function xraySettings(target) {
  const x = target.def.xray ?? {};
  const key = x.project_key || process.env[x.project_key_env ?? 'XRAY_PROJECT_KEY'] || target.env[x.project_key_env ?? 'XRAY_PROJECT_KEY'] || '';
  return { projectKey: key, repositoryPath: x.test_repository_path ?? `reverse-qa/${target.name}` };
}

export function loadInputs(target) {
  const out = outputDir(target.dir);
  const doc = readYaml(path.join(out, 'test-cases', 'cases.yaml'));
  if (!doc) throw new Error(`no test cases yet: ${path.join(out, 'test-cases', 'cases.yaml')} (written by test-designer)`);
  const reqs = readYaml(path.join(out, 'requirements.yaml'));
  const requirementIds = Array.isArray(reqs) ? new Set(reqs.map((r) => r.id)) : null;
  const jiraKeys = readYaml(path.join(out, 'jira-keys.yaml')) ?? {};
  // the review gate, once a person has started it for this target: null = not started, nothing is held back
  return { doc, requirementIds, jiraKeys, approved: approvedRequirementIds(target.dir) };
}

export function exportCases(target) {
  const { doc, requirementIds, jiraKeys, approved } = loadInputs(target);
  const { problems, uncovered } = validateCases(doc, requirementIds);
  // no test case before approval: a case for a requirement nobody approved fails, and only approved ones need a case
  const early = approved ? (doc.cases ?? []).flatMap((c) => [c.requirement].flat().filter((r) => requirementIds?.has(r) && !approved.has(r)).map((r) => `${c.id}: requirement ${r} is not approved at the review gate (review-gate --show ${r})`)) : [];
  const need = approved ? uncovered.filter((r) => approved.has(r)) : uncovered;
  const all = [...problems, ...early, ...need.map((r) => `requirement ${r} has no test case`)];
  if (all.length) return { ok: false, problems: all };
  const { projectKey, repositoryPath } = xraySettings(target);
  const features = toFeatures(doc, { jiraKeys });
  for (const [name, text] of Object.entries(features)) writeOutput(target.dir, `test-cases/features/${name}`, text);
  const csv = toImporterCsv(doc, { jiraKeys, repositoryPath });
  writeOutput(target.dir, 'xray/xray-import.csv', csv);
  let bulk = null;
  if (projectKey || doc.project_key) {
    bulk = toBulk(doc, { projectKey, jiraKeys, repositoryPath });
    const bulkProblems = validateBulkTests(bulk);
    if (bulkProblems.length) return { ok: false, problems: bulkProblems };
    writeOutput(target.dir, 'xray/xray-tests.json', `${JSON.stringify(bulk, null, 2)}\n`);
  }
  const unmappedReqs = [...new Set(doc.cases.flatMap((c) => [c.requirement].flat()))].filter((r) => !jiraKeys[r]).sort();
  const result = {
    ok: true,
    cases: doc.cases.length,
    manual: doc.cases.filter((c) => c.type === 'manual').length,
    cucumber: doc.cases.filter((c) => c.type === 'cucumber').length,
    features: Object.keys(features).length,
    csvRows: csv.trim().split('\r\n').length - 1,
    bulk: bulk ? { tests: bulk.length, linked: bulk.filter((t) => t.update).length } : null,
    unmappedReqs,
  };
  appendLedger(target.dir, 'export-xray', { cases: result.cases, bulk: result.bulk, unmappedReqs });
  return result;
}

export function exportResults(target, reportFile) {
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const testKeys = readJson(path.join(outputDir(target.dir), 'xray', 'xray-keys.json')) ?? {};
  // cases may select results through `covers`; k6 results are not in a Playwright report and are not sent to Xray
  const casesFile = path.join(outputDir(target.dir), 'test-cases', 'cases.yaml');
  const cases = fs.existsSync(casesFile) ? YAML.parse(fs.readFileSync(casesFile, 'utf8'))?.cases ?? [] : [];
  const r = toXrayResults(report, { testKeys, cases, summary: `reverse-qa ${target.name}: automated run` });
  writeOutput(target.dir, 'xray/xray-results.json', `${JSON.stringify(r.results, null, 2)}\n`);
  appendLedger(target.dir, 'export-xray-results', { tests: r.results.tests.length, unmapped: r.unmapped.length, unlinked: r.unlinked.length });
  return r;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, results: { type: 'string' } } });
  if (!values.target) {
    process.stderr.write('usage: export.mjs --target <name> [--results <playwright-report.json>]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    if (values.results) {
      const r = exportResults(target, path.resolve(values.results));
      process.stdout.write(`export-xray: ${r.results.tests.length} test result(s) → xray/xray-results.json; ${r.unmapped.length} case(s) without an Xray key (publish tests first), ${r.unlinked.length} spec(s) without a @TC- tag\n`);
      return 0;
    }
    const r = exportCases(target);
    if (!r.ok) {
      process.stderr.write(`export-xray: ${r.problems.length} problem(s):\n${r.problems.map((p) => `  ${p}`).join('\n')}\n`);
      return 2;
    }
    const bulk = r.bulk ? `xray-tests.json (${r.bulk.tests} tests, ${r.bulk.linked} linked to Jira requirements)` : 'no xray-tests.json (set xray.project_key in target.yaml or XRAY_PROJECT_KEY)';
    process.stdout.write(`export-xray: ${r.cases} cases (${r.manual} manual, ${r.cucumber} cucumber) → ${bulk}, ${r.features} feature file(s), xray-import.csv (${r.csvRows} rows); ${r.unmappedReqs.length} requirement(s) without a Jira key\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`export-xray: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
