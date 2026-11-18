#!/usr/bin/env node
// publish-xray: send the exported tests (or results) to Xray Cloud, in two steps.
//   node publish.mjs --target <name>                        dry run: validate, summarize, write the preview_id
//   node publish.mjs --target <name> --confirm <preview_id> real import, only for the exact payload previewed
//   add --results to do the same for xray/xray-results.json
//   exit 0 = done, 2 = refused (invalid payload or preview mismatch) or Xray failed, 1 = usage or configuration
// Credentials: XRAY_CLIENT_ID / XRAY_CLIENT_SECRET (and optional XRAY_BASE_URL) from the environment or the target's
// gitignored .env. They are never written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { XrayClient, configFromEnv, previewTests, publishTests, previewResults, publishResults } from '../../mcp/xray/core.mjs';
import { loadInputs } from '../export-xray/export.mjs';

const STATUS_ORDER = ['PASSED', 'PASS', 'FAILED', 'FAIL', 'TODO', 'EXECUTING'];

function payloadFile(target, results) {
  const file = path.join(outputDir(target.dir), 'xray', results ? 'xray-results.json' : 'xray-tests.json');
  if (!fs.existsSync(file)) throw new Error(`${file} not found: run export-xray${results ? ' --results <report>' : ''} first`);
  return file;
}

export function dryRun(target, { results = false } = {}) {
  const payload = JSON.parse(fs.readFileSync(payloadFile(target, results), 'utf8'));
  const preview = results ? previewResults(payload) : previewTests(payload);
  let missingKeys = [];
  if (!results) {
    const { doc, jiraKeys } = loadInputs(target);
    missingKeys = [...new Set(doc.cases.flatMap((c) => [c.requirement].flat()))].filter((r) => !jiraKeys[r]).sort();
  }
  const out = { kind: results ? 'results' : 'tests', ...preview, requirements_without_jira_key: missingKeys };
  writeOutput(target.dir, `xray/publish-preview${results ? '-results' : ''}.json`, `${JSON.stringify(out, null, 2)}\n`);
  appendLedger(target.dir, 'publish-xray-dry-run', { kind: out.kind, preview_id: out.preview_id, ready: out.ready });
  return out;
}

export async function confirm(target, previewIdValue, { results = false, env = { ...target.env, ...process.env }, fetchImpl } = {}) {
  const payload = JSON.parse(fs.readFileSync(payloadFile(target, results), 'utf8'));
  const client = new XrayClient({ ...configFromEnv(env), ...(fetchImpl ? { fetchImpl } : {}) });
  if (results) {
    const r = await publishResults(client, payload, previewIdValue);
    appendLedger(target.dir, 'publish-xray-results', { test_execution: r.test_execution });
    return r;
  }
  const r = await publishTests(client, payload, previewIdValue);
  const { doc } = loadInputs(target);
  const keyFile = path.join(outputDir(target.dir), 'xray', 'xray-keys.json');
  const keys = fs.existsSync(keyFile) ? JSON.parse(fs.readFileSync(keyFile, 'utf8')) : {};
  doc.cases.forEach((c, i) => {
    if (r.keys[i]) keys[c.id] = r.keys[i];
  });
  writeOutput(target.dir, 'xray/xray-keys.json', `${JSON.stringify(keys, null, 2)}\n`);
  appendLedger(target.dir, 'publish-xray', { job_id: r.job_id, status: r.status, created: r.keys.filter(Boolean).length, errors: r.errors.length });
  return r;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, confirm: { type: 'string' }, results: { type: 'boolean' } } });
  if (!values.target) {
    process.stderr.write('usage: publish.mjs --target <name> [--results] [--confirm <preview_id>]\n');
    return 1;
  }
  let target;
  try {
    target = loadTarget(projectRoot(values.root), values.target);
  } catch (err) {
    process.stderr.write(`publish-xray: ${err.message}\n`);
    return 1;
  }
  try {
    if (!values.confirm) {
      const p = dryRun(target, { results: values.results });
      const what = p.kind === 'tests' ? `${p.tests} tests (${Object.entries(p.by_type).map(([k, v]) => `${v} ${k}`).join(', ')}), ${p.linked_to_requirements} linked to Jira requirements, ${p.requirements_without_jira_key.length} requirement(s) without a Jira key` : `${p.tests} results (${Object.entries(p.by_status).sort(([a], [b]) => STATUS_ORDER.indexOf(a) - STATUS_ORDER.indexOf(b)).map(([k, v]) => `${v} ${k}`).join(', ')})`;
      if (!p.ready) {
        process.stderr.write(`publish-xray: DRY RUN, not ready: ${what}\n${p.problems.map((x) => `  ${x}`).join('\n')}\n`);
        return 2;
      }
      process.stdout.write(`publish-xray: DRY RUN, nothing sent. ${what}. preview_id ${p.preview_id}\nTo publish, show this summary to the person running reverse-qa and, only after they confirm, run again with --confirm ${p.preview_id}\n`);
      return 0;
    }
    const r = await confirm(target, values.confirm, { results: values.results });
    if (values.results) process.stdout.write(`publish-xray: results imported into Test Execution ${r.test_execution ?? '(key not returned)'}\n`);
    else process.stdout.write(`publish-xray: import job ${r.job_id} ${r.status}: ${r.keys.filter(Boolean).length} test(s) created, ${r.errors.length} error(s); keys saved to xray/xray-keys.json\n`);
    return r.errors?.length ? 2 : 0;
  } catch (err) {
    process.stderr.write(`publish-xray: ${err.message}\n`);
    return /refusing/.test(err.message) ? 2 : 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
