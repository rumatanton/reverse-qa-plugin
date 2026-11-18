#!/usr/bin/env node
// publish-bugs: create Jira Bugs from output/bugs/bugs.json (written by bug-reporter), in two steps.
//   node publish.mjs --target <name>                        dry run: validate, summarize, write the preview_id
//   node publish.mjs --target <name> --confirm <preview_id> create the bugs, attach evidence, link requirement and test
//   exit 0 = done, 2 = refused (invalid, preview mismatch) or Jira rejected a bug, 1 = usage or configuration
// Settings: target.yaml jira.base_url, jira.project_key, jira.priority_map, jira.link_type (default "Relates").
// Credentials: JIRA_EMAIL + JIRA_API_TOKEN (Jira Cloud) or JIRA_PAT (Data Center), from the environment or the
// target's gitignored .env. Bugs already created (output/bugs/jira-bug-keys.json) are skipped, so a rerun is safe.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { outputDir, writeOutput, appendLedger } from '../../lib/ledger.mjs';
import { parseCsv } from '../../lib/csv.mjs';
import { previewId } from '../../lib/xray.mjs';
import { validateBugs, toJiraIssue, secretValues } from '../../lib/bugs.mjs';

const readJson = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
const readYaml = (f) => (fs.existsSync(f) ? YAML.parse(fs.readFileSync(f, 'utf8')) ?? {} : {});

export function jiraSettings(target, env = { ...target.env, ...process.env }) {
  const j = target.def.jira ?? {};
  return {
    baseUrl: (env.JIRA_BASE_URL || j.base_url || '').replace(/\/+$/, ''),
    projectKey: env.JIRA_PROJECT_KEY || j.bug_project_key || j.project_key || '',
    priorityMap: j.priority_map ?? null,
    linkType: j.link_type ?? 'Relates',
    auth: env.JIRA_PAT ? `Bearer ${env.JIRA_PAT}` : env.JIRA_EMAIL && env.JIRA_API_TOKEN ? `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}` : null,
  };
}

/** The bugs still to create, each rendered as a Jira create-issue body. */
export function plan(target) {
  const out = outputDir(target.dir);
  const doc = readJson(path.join(out, 'bugs', 'bugs.json'));
  if (!doc.bugs) throw new Error(`${path.join(out, 'bugs', 'bugs.json')} not found: bug-reporter writes it`);
  const findings = fs.existsSync(path.join(out, 'findings.csv')) ? parseCsv(fs.readFileSync(path.join(out, 'findings.csv'), 'utf8')) : [];
  const problems = validateBugs(doc, { findings, targetDir: target.dir, secrets: secretValues({ ...target.env, ...process.env }) });
  const created = readJson(path.join(out, 'bugs', 'jira-bug-keys.json'));
  const jiraKeys = readYaml(path.join(out, 'jira-keys.yaml'));
  const xrayKeys = readJson(path.join(out, 'xray', 'xray-keys.json'));
  const s = jiraSettings(target);
  const todo = (doc.bugs ?? []).filter((b) => !created[b.id]).map((b) => {
    const requirementKey = jiraKeys[b.requirement] ?? null;
    const testKey = (b.test_ids ?? []).map((t) => xrayKeys[t]).find(Boolean) ?? null;
    return { bug: b, requirementKey, testKey, issue: toJiraIssue(b, { projectKey: s.projectKey || 'UNSET', priorityMap: s.priorityMap, requirementKey, testKey }) };
  });
  const warnings = s.projectKey ? [] : ['no Jira project yet (jira.project_key or JIRA_PROJECT_KEY): the reports are valid, but --confirm needs it'];
  return { todo, problems, warnings, alreadyCreated: Object.keys(created).length, preview_id: previewId(todo.map((t) => t.issue)) };
}

async function jira(s, fetchImpl, method, url, body, headers = {}) {
  const res = await fetchImpl(`${s.baseUrl}${url}`, { method, headers: { authorization: s.auth, accept: 'application/json', ...headers }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`Jira ${method} ${url}: HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

export async function publish(target, expectedPreview, { fetchImpl = fetch } = {}) {
  const p = plan(target);
  if (p.problems.length) throw new Error(`refusing: ${p.problems.length} problem(s): ${p.problems.slice(0, 5).join('; ')}`);
  if (p.preview_id !== expectedPreview) throw new Error(`refusing: preview_id ${expectedPreview} does not match the bugs as they are now (${p.preview_id}); run the dry run again`);
  const s = jiraSettings(target);
  if (!s.projectKey) throw new Error('Jira is not configured: set jira.project_key in target.yaml (or JIRA_PROJECT_KEY)');
  if (!s.baseUrl || !s.auth) throw new Error('Jira is not configured: jira.base_url plus JIRA_EMAIL and JIRA_API_TOKEN (or JIRA_PAT)');
  const keysFile = path.join(outputDir(target.dir), 'bugs', 'jira-bug-keys.json');
  const keys = readJson(keysFile);
  const results = [];
  for (const t of p.todo) {
    const created = await jira(s, fetchImpl, 'POST', '/rest/api/3/issue', JSON.stringify(t.issue), { 'content-type': 'application/json' });
    keys[t.bug.id] = created.key;
    writeOutput(target.dir, 'bugs/jira-bug-keys.json', `${JSON.stringify(keys, null, 2)}\n`); // saved per bug: a later failure never loses a created key
    let attached = 0;
    for (const a of t.bug.attachments ?? []) {
      const form = new FormData();
      form.append('file', new Blob([fs.readFileSync(path.resolve(target.dir, a))]), path.basename(a));
      await jira(s, fetchImpl, 'POST', `/rest/api/3/issue/${encodeURIComponent(created.key)}/attachments`, form, { 'X-Atlassian-Token': 'no-check' });
      attached++;
    }
    const linked = [];
    for (const other of [t.requirementKey, t.testKey].filter(Boolean)) {
      await jira(s, fetchImpl, 'POST', '/rest/api/3/issueLink', JSON.stringify({ type: { name: s.linkType }, inwardIssue: { key: created.key }, outwardIssue: { key: other } }), { 'content-type': 'application/json' });
      linked.push(other);
    }
    results.push({ bug: t.bug.id, key: created.key, attached, linked });
  }
  appendLedger(target.dir, 'publish-bugs', { created: results.map((r) => `${r.bug}=${r.key}`) });
  return results;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' }, confirm: { type: 'string' } } });
  if (!values.target) {
    process.stderr.write('usage: publish.mjs --target <name> [--confirm <preview_id>]\n');
    return 1;
  }
  let target;
  try {
    target = loadTarget(projectRoot(values.root), values.target);
  } catch (err) {
    process.stderr.write(`publish-bugs: ${err.message}\n`);
    return 1;
  }
  try {
    if (!values.confirm) {
      const p = plan(target);
      writeOutput(target.dir, 'bugs/publish-preview.json', `${JSON.stringify({ preview_id: p.preview_id, bugs: p.todo.map((t) => ({ id: t.bug.id, finding: t.bug.finding_id, severity: t.bug.severity, summary: t.bug.summary, attachments: (t.bug.attachments ?? []).length, links: [t.requirementKey, t.testKey].filter(Boolean) })), problems: p.problems }, null, 2)}\n`);
      appendLedger(target.dir, 'publish-bugs-dry-run', { preview_id: p.preview_id, bugs: p.todo.length, problems: p.problems.length });
      if (p.problems.length) {
        process.stderr.write(`publish-bugs: DRY RUN, not ready (${p.problems.length} problem(s)):\n${p.problems.map((x) => `  ${x}`).join('\n')}\n`);
        return 2;
      }
      const sev = Object.entries(p.todo.reduce((m, t) => ((m[t.bug.severity] = (m[t.bug.severity] ?? 0) + 1), m), {})).map(([k, v]) => `${v} ${k}`).join(', ');
      process.stdout.write(`publish-bugs: DRY RUN, nothing sent. ${p.todo.length} bug(s) to create (${sev || 'none'}), ${p.alreadyCreated} already in Jira.${p.warnings.length ? ` Note: ${p.warnings.join('; ')}.` : ''} preview_id ${p.preview_id}\nShow output/bugs/bugs.json and this summary to the person running reverse-qa; only after they confirm, run again with --confirm ${p.preview_id}\n`);
      return 0;
    }
    const r = await publish(target, values.confirm);
    process.stdout.write(`publish-bugs: ${r.length} bug(s) created: ${r.map((x) => `${x.bug} → ${x.key} (${x.attached} attachment(s), linked ${x.linked.join(', ') || 'none'})`).join('; ') || 'nothing to do'}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`publish-bugs: ${err.message}\n`);
    return /refusing/.test(err.message) ? 2 : 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
