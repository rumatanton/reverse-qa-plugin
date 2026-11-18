// init-target: a new app goes from a source folder to a scanned inventory with no hand-written target.yaml, and the
// prerequisite checks say plainly what is missing. Fixture: tests/fixtures/mini-api (an API with a spec, no pages).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { PLUGIN, runNode } from '../helpers.mjs';
import { detect, capabilities } from '../../lib/platform.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { targetYaml, doctor, nextSteps } from '../../skills/init-target/init.mjs';

const INIT = path.join(PLUGIN, 'skills', 'init-target', 'init.mjs');
const SCAN = path.join(PLUGIN, 'skills', 'scan-repo', 'scan.mjs');
const MINI_API = path.join(PLUGIN, 'tests', 'fixtures', 'mini-api');
const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-init-'));

test('targetYaml: loads, states what was detected, and writes only the blocks that apply', () => {
  const detected = detect(MINI_API);
  const def = YAML.parse(targetYaml({ name: 'shop-api', detected, kind: 'api', url: 'http://localhost:8095', openapi: 'openapi.yaml', date: '2026-11-10' }));
  assert.deepEqual([def.name, def.app.kind, def.source.dir_env, def.source.stack, def.runtime.base_url, def.api.openapi], ['shop-api', 'api', 'TARGET_DIR', 'unknown', 'http://localhost:8095/', 'openapi.yaml']);
  assert.deepEqual(def.safety, { allowed_test_hosts: ['localhost', '127.0.0.1'], never_test: [] });
  assert.equal(def.database, undefined, 'no database block until the person adds one');
  const remote = YAML.parse(targetYaml({ name: 'x', detected, kind: 'web', url: 'https://qa.shop.example.test/app', date: '2026-11-10' }));
  assert.deepEqual(remote.safety.allowed_test_hosts, ['localhost', '127.0.0.1', 'qa.shop.example.test'], 'a remote test host is allowed explicitly');
  const none = YAML.parse(targetYaml({ name: 'x', detected, kind: 'mobile', date: '2026-11-10' }));
  assert.equal(none.runtime, undefined, 'no URL: analysis only');
  assert.match(nextSteps('x', capabilities(none)).join(' '), /Automated tests: needs the Appium driver/);
});

test('from a source folder to an inventory: init, doctor, scan, with no hand-written file', () => {
  const root = tempRoot();
  const made = runNode(INIT, ['--name', 'shop-api', '--source', MINI_API, '--root', root]);
  assert.equal(made.status, 0, made.stderr);
  assert.match(made.stdout, /a api app \(an API spec \(openapi\.yaml\) and no page templates\); API spec openapi\.yaml/);
  assert.match(made.stdout, /yes {2}Requirements, user stories, risk register, test cases, bug reports \(any language\)/);
  assert.match(made.stdout, /no {3}Automated tests \(needs runtime\.base_url\)/);
  assert.match(made.stdout, /Next:\n {2}1\. Fill the TODO lines/);
  const dir = path.join(root, 'targets', 'shop-api');
  for (const f of ['target.yaml', '.env', '.env.example', '.gitignore']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  assert.equal(loadTarget(root, 'shop-api').sourceDir, path.resolve(MINI_API));
  // the workspace is any folder, so the target folder itself keeps .env (source path, test accounts) out of git
  const ignored = fs.readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n');
  for (const line of ['.env', '!.env.example', 'output/runs/']) assert.ok(ignored.includes(line), `.gitignore lists ${line}`);
  fs.appendFileSync(path.join(dir, '.gitignore'), 'mine/\n');

  const check = runNode(INIT, ['--doctor', '--target', 'shop-api', '--root', root]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /PASS {2}source folder exists/);
  assert.match(check.stdout, /NOTE {2}Docker not needed/);
  assert.match(check.stdout, /PASS {2}API spec exists: openapi\.yaml/);
  assert.match(check.stdout, /init-target: ready/);

  const scan = runNode(SCAN, ['--target', 'shop-api', '--root', root]);
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /3 files \(7 pages: 7 from the API spec, 0 includes, 0 parse errors\)/);
  assert.match(scan.stdout, /outbound hosts \[pay\.example\.test\]/);
  assert.match(scan.stdout, /10 route hints \(2 matched no page\)/);
  const inv = JSON.parse(fs.readFileSync(path.join(dir, 'output', 'inventory.json'), 'utf8'));
  assert.deepEqual(inv.pack, { name: 'generic', version: '1.0.0', language_version: null });
  const [citedFile, citedLine] = inv.pages.find((p) => p.path === 'orders/{id}').evidence[0].split(':');
  assert.equal(citedFile, 'openapi.yaml');
  assert.equal(fs.readFileSync(path.join(MINI_API, 'openapi.yaml'), 'utf8').split('\n')[Number(citedLine) - 1].trim(), '/orders/{id}:', 'a spec endpoint cites its own line in the spec');

  const again = runNode(INIT, ['--name', 'shop-api', '--source', MINI_API, '--root', root]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /target\.yaml already exists \(use --force to replace it\)/);
  assert.equal(runNode(INIT, ['--name', 'shop-api', '--source', MINI_API, '--root', root, '--kind', 'web', '--force']).status, 0, 'the person can correct the kind');
  assert.match(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), /^mine\/$/m, 'a .gitignore the person edited is never replaced');
});

test('scan with no pages yet says what to do next; usage and bad input exit 1', () => {
  const root = tempRoot();
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-src-'));
  fs.writeFileSync(path.join(src, 'Repo.java'), 'class Repo { String q = "SELECT id, name FROM users WHERE id = ?"; }\n');
  assert.equal(runNode(INIT, ['--name', 'legacy', '--source', src, '--root', root]).status, 0);
  const scan = runNode(SCAN, ['--target', 'legacy', '--root', root]);
  assert.equal(scan.status, 0, scan.stderr);
  assert.match(scan.stdout, /1 files \(0 pages, 0 includes, 0 parse errors\), 1 SQL statements/);
  assert.match(scan.stdout, /no pages yet\. The generic pack does not read pages from source: run crawl-app on the running app, or set api\.openapi/);
  assert.equal(runNode(INIT, []).status, 1);
  assert.equal(runNode(INIT, ['--name', 'Bad Name', '--source', src, '--root', root]).status, 1);
  assert.equal(runNode(INIT, ['--name', 'x', '--source', path.join(src, 'nope'), '--root', root]).status, 1);
  assert.equal(runNode(INIT, ['--name', 'x', '--source', src, '--kind', 'console', '--root', root]).status, 1);
  const detectOnly = runNode(INIT, ['--detect', '--source', src]);
  assert.equal(detectOnly.status, 0);
  assert.match(detectOnly.stdout, /no known project file; a web app/);
});

test('doctor: a URL target must be allowed and must answer; a non-local host is called out; a missing driver is a note', async () => {
  const mk = (def) => ({ name: 't', dir: os.tmpdir(), def, env: {}, sourceDir: MINI_API });
  const up = async () => ({ status: 200 });
  const down = async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); };
  const by = (checks) => Object.fromEntries(checks.map((c) => [c.what, c]));
  const base = { app: { kind: 'api' }, source: { dir_env: 'TARGET_DIR', stack: 'unknown' }, safety: { allowed_test_hosts: ['localhost'], never_test: ['shop.example.test'] } };

  const ok = by(await doctor(mk({ ...base, runtime: { base_url: 'http://localhost:8095/' } }), { fetchImpl: up }));
  assert.equal(ok['the app answers at the base URL'].level, 'PASS');
  assert.equal(ok['no test accounts'].level, 'NOTE');
  const off = by(await doctor(mk({ ...base, runtime: { base_url: 'http://localhost:8095/' } }), { fetchImpl: down }));
  assert.deepEqual([off['the app answers at the base URL'].level, off['the app answers at the base URL'].detail], ['FAIL', 'no answer from http://localhost:8095/ (ECONNREFUSED)']);
  const prod = by(await doctor(mk({ ...base, runtime: { base_url: 'https://shop.example.test/' } }), { fetchImpl: up }));
  assert.equal(prod['base URL host is allowed for tests'].level, 'FAIL', 'a host in never_test is refused, and never contacted');
  assert.equal(prod['the app answers at the base URL'], undefined);
  const remote = by(await doctor(mk({ ...base, safety: { allowed_test_hosts: ['qa.example.test'] }, runtime: { base_url: 'https://qa.example.test/' } }), { fetchImpl: up }));
  assert.equal(remote['tests will send requests to qa.example.test'].level, 'NOTE');
  const mobile = by(await doctor(mk({ ...base, app: { kind: 'mobile' } }), { fetchImpl: up }));
  assert.equal(mobile['no driver built yet for mobile apps'].level, 'NOTE');
  assert.match(mobile['no driver built yet for mobile apps'].detail, /everything up to test cases works/);
  assert.equal((await doctor(mk({ ...base, app: { kind: 'tv' } })))[0].level, 'FAIL');
});
