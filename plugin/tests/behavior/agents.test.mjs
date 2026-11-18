// Agent behavior tests (opt-in: RQA_BEHAVIOR=1; they spend model tokens). Each subagent runs headless with the plugin
// loaded, on the mini-shop fixture whose answers are known (EXPECTED.md), and code checks its output: planted facts
// found, every citation resolves, requirements and test cases pass their schemas. No LLM judges another LLM.
// Cost and duration of every run are recorded in tests/behavior/.runs/. RQA_BEHAVIOR_RESUME=1 reuses the last run's project
// (.runs/project.txt) and skips an agent whose outputs already exist; its output is still checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import YAML from 'yaml';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { writeInventory } from '../../skills/scan-repo/scan.mjs';
import { parseCsv, toCsv } from '../../lib/csv.mjs';
import { loadCatalogue, tableRows } from '../../lib/testtypes.mjs';

const enabled = process.env.RQA_BEHAVIOR === '1' || process.env.npm_lifecycle_event === 'test:behavior'; // paid: only on purpose
const RUNS = path.join(PLUGIN, 'tests', 'behavior', '.runs');
const TOOLS = 'Read,Write,Edit,Glob,Grep,Bash(node:*),Task';

/** Run one subagent headless; returns the parsed JSON result (cost, duration, text). */
function runAgent(root, agent, task) {
  const prompt = `Use the reverse-qa:${agent} subagent for the target "mini-shop" in this project (targets/mini-shop). ${task} The target source path is in targets/mini-shop/.env (MINI_SHOP_DIR). Work only inside targets/mini-shop/output.`;
  const r = spawnSync('claude', ['-p', JSON.stringify(prompt), '--plugin-dir', JSON.stringify(PLUGIN), '--output-format', 'json', '--allowedTools', JSON.stringify(TOOLS)], {
    cwd: root,
    shell: true,
    encoding: 'utf8',
    timeout: 2_400_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
  let result = null;
  try {
    result = JSON.parse(r.stdout);
  } catch {
    result = { raw: r.stdout?.slice(-2000), stderr: r.stderr?.slice(-2000) };
  }
  fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(path.join(RUNS, `${agent}.json`), JSON.stringify({ agent, exit: r.status, cost_usd: result?.total_cost_usd ?? null, duration_ms: result?.duration_ms ?? null, result: result?.result?.slice?.(0, 4000) ?? result }, null, 2));
  // an account limit stops the run before the agent is done: say so, so it is not read as an agent defect
  const text = `${result?.result ?? ''} ${JSON.stringify(result?.raw ?? '')} ${r.stderr ?? ''}`;
  if (r.status !== 0 && /hit your (session|usage) limit|usage limit reached|rate limit/i.test(text)) {
    assert.fail(`environment, not the ${agent} agent: the Claude account hit its usage limit (${text.match(/[^.\n]*limit[^.\n]*/i)?.[0].trim()}). Rerun with RQA_BEHAVIOR_RESUME=1 after the reset.`);
  }
  assert.equal(r.status, 0, `claude -p exited ${r.status}: ${(r.stderr || '').slice(-500)}`);
  return result;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, 'output', rel), 'utf8');
const citationsPass = (root) => runNode(path.join(PLUGIN, 'skills', 'check-citations', 'check.mjs'), ['--target', 'mini-shop', '--root', root]);

/** A fresh project, or with RQA_BEHAVIOR_RESUME=1 the one the last run used. */
function project() {
  const pointer = path.join(RUNS, 'project.txt');
  if (process.env.RQA_BEHAVIOR_RESUME === '1' && fs.existsSync(pointer)) {
    const root = fs.readFileSync(pointer, 'utf8').trim();
    if (fs.existsSync(path.join(root, 'targets', 'mini-shop', 'target.yaml'))) return { root, target: path.join(root, 'targets', 'mini-shop') };
  }
  const p = tempProject();
  writeInventory(loadTarget(p.root, 'mini-shop'), JSON.parse(fs.readFileSync(path.join(PLUGIN, 'tests', 'fixtures', 'scan', 'mini-shop.raw.json'), 'utf8')));
  fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(pointer, p.root);
  return p;
}

/** Run the agent unless resuming and every one of its outputs already exists. */
function runUnlessDone(root, target, agent, outputs, task) {
  if (process.env.RQA_BEHAVIOR_RESUME === '1' && outputs.every((o) => fs.existsSync(path.join(target, 'output', o)))) return;
  runAgent(root, agent, task);
}

test('subagents on mini-shop: planted facts found, citations resolve, schemas hold', { skip: !enabled && 'set RQA_BEHAVIOR=1 (uses model tokens)', timeout: 7_200_000 }, async (t) => {
  const { root, target } = project();

  await t.test('tech-analyst', () => {
    runUnlessDone(root, target, 'tech-analyst', ['docs/01-architecture.md', 'docs/02-security.md', 'docs/08-test-types.md', 'findings.csv'], 'Write docs 01-architecture.md, 02-security.md, the draft 05-endpoint-catalog.md, 08-test-types.md and findings.csv.');
    const arch = read(target, 'docs/01-architecture.md');
    const sec = read(target, 'docs/02-security.md');
    for (const fact of ['users', 'products', 'cart', 'orders', 'pay.example.test']) assert.ok(arch.includes(fact), `01-architecture mentions ${fact}`);
    for (const fact of ['UID', 'ADMIN', 'admin/report.php']) assert.ok(sec.includes(fact), `02-security mentions ${fact}`);
    // which test types the app needs: the citation check below also holds it to the catalogue (lib/testtypes.mjs)
    assert.ok(tableRows(read(target, 'docs/08-test-types.md')).length >= loadCatalogue().length, '08-test-types has a row for every catalogue type');
    const c = citationsPass(root);
    assert.equal(c.status, 0, c.stderr);
    assert.match(c.stdout, /check-citations: (\d{2,}) citation/, 'at least 10 citations');
    const findings = parseCsv(read(target, 'findings.csv'));
    assert.ok(findings.some((f) => /admin\/report\.php/.test(`${f.root_cause} ${f.evidence}`)), 'the planted redirect-without-exit is a finding');
  });

  await t.test('workflow-analyst', () => {
    runUnlessDone(root, target, 'workflow-analyst', ['requirements.yaml', 'role-matrix.csv', 'risk-register.csv'], 'Write 03-roles.md, role-matrix.csv, 04-workflows.md, requirements.yaml and risk-register.csv.');
    const reqs = YAML.parse(read(target, 'requirements.yaml'));
    assert.ok(Array.isArray(reqs) && reqs.length >= 5, `${reqs?.length} requirements`);
    for (const r of reqs) {
      assert.match(r.id, /^REQ-[A-Z]+-\d{3}$/);
      assert.ok(r.evidence?.length, `${r.id} has evidence`);
      assert.ok(['verified', 'code-only', 'inferred'].includes(r.label), `${r.id} label`);
    }
    // speed, accessibility and browser support are requirements too (the load, axe-core and other-browser results trace to them)
    assert.ok(reqs.some((r) => /^REQ-(PERF|ACC|COMPAT)-\d{3}$/.test(r.id)), 'non-functional requirements are written');
    const matrix = parseCsv(read(target, 'role-matrix.csv'));
    assert.ok(matrix.some((c) => c.page === 'admin/report.php' && c.role === 'Visitor'), 'role matrix covers the admin report for visitors');
    const risks = parseCsv(read(target, 'risk-register.csv'));
    assert.ok(risks.every((r) => Number(r.score) === Number(r.likelihood) * Number(r.impact)), 'score = likelihood × impact');
    const c = citationsPass(root);
    assert.equal(c.status, 0, c.stderr);
  });

  await t.test('test-designer', () => {
    runUnlessDone(root, target, 'test-designer', ['test-cases/cases.yaml', 'docs/06-test-strategy.md'], 'The requirements are approved. Write test-cases/cases.yaml, docs/06-test-strategy.md and test-plan.md, then run export-xray until it exits 0.');
    const r = runNode(path.join(PLUGIN, 'skills', 'export-xray', 'export.mjs'), ['--target', 'mini-shop', '--root', root]);
    assert.equal(r.status, 0, `export-xray: ${r.stderr}`);
    assert.ok(fs.existsSync(path.join(target, 'output', 'docs', '06-test-strategy.md')));
  });

  await t.test('bug-reporter', () => {
    // a person confirms the planted finding (as a reproducing test would), then the agent writes the bug
    const file = path.join(target, 'output', 'findings.csv');
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const planted = rows.find((f) => /admin\/report\.php/.test(`${f.root_cause} ${f.evidence}`));
    assert.ok(planted, 'the planted finding exists');
    planted.status = 'confirmed';
    fs.writeFileSync(file, toCsv(rows, Object.keys(rows[0])));
    runUnlessDone(root, target, 'bug-reporter', ['bugs/bugs.json'], 'Write one bug report per confirmed finding (bugs/bugs.json and BUG-*.md), then run the publish-bugs dry run until it exits 0.');
    const r = runNode(path.join(PLUGIN, 'skills', 'publish-bugs', 'publish.mjs'), ['--target', 'mini-shop', '--root', root]);
    assert.equal(r.status, 0, `publish-bugs dry run: ${r.stderr}`);
    const bugs = JSON.parse(read(target, 'bugs/bugs.json')).bugs;
    assert.deepEqual(bugs.map((x) => x.finding_id), [planted.id], 'one bug, for the one confirmed finding');
    assert.match(bugs[0].root_cause, /admin\/report\.php:\d+/);
  });
});
