// export-xray and publish-xray as a person runs them: export, dry run, confirm (against the mock Xray), results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, tempProject, runNode, runNodeAsync } from '../helpers.mjs';
import { startMockXray } from '../xray-mock.mjs';
import { validateBulkTests } from '../../lib/xray.mjs';

const EXPORT = path.join(PLUGIN, 'skills', 'export-xray', 'export.mjs');
const PUBLISH = path.join(PLUGIN, 'skills', 'publish-xray', 'publish.mjs');
const FX = path.join(PLUGIN, 'tests', 'fixtures', 'xray');

function project({ projectKey = 'QA', cases = 'mini-shop-cases.yaml' } = {}) {
  const p = tempProject();
  const out = path.join(p.target, 'output');
  fs.mkdirSync(path.join(out, 'test-cases'), { recursive: true });
  fs.copyFileSync(path.join(FX, cases), path.join(out, 'test-cases', 'cases.yaml'));
  fs.copyFileSync(path.join(FX, 'mini-shop-requirements.yaml'), path.join(out, 'requirements.yaml'));
  fs.writeFileSync(path.join(out, 'jira-keys.yaml'), 'REQ-AUTH-001: QA-11\nREQ-PAY-001: QA-12\n');
  if (projectKey) fs.appendFileSync(path.join(p.target, 'target.yaml'), `xray:\n  project_key: ${projectKey}\n  test_repository_path: reverse-qa/mini-shop\n`);
  return { ...p, out };
}

test('export writes bulk JSON, importer CSV and feature files, and prints the counts', () => {
  const { root, out } = project();
  const r = runNode(EXPORT, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'export-xray: 4 cases (3 manual, 1 cucumber) → xray-tests.json (4 tests, 3 linked to Jira requirements), 3 feature file(s), xray-import.csv (6 rows); 1 requirement(s) without a Jira key');
  const bulk = JSON.parse(fs.readFileSync(path.join(out, 'xray', 'xray-tests.json'), 'utf8'));
  assert.deepEqual(validateBulkTests(bulk), []);
  assert.ok(fs.existsSync(path.join(out, 'test-cases', 'features', 'auth.feature')));
  assert.ok(fs.existsSync(path.join(out, 'xray', 'xray-import.csv')));
});

test('export fails with exit 2 when a requirement has no test case', () => {
  const { root, out } = project();
  const cases = fs.readFileSync(path.join(out, 'test-cases', 'cases.yaml'), 'utf8');
  fs.writeFileSync(path.join(out, 'test-cases', 'cases.yaml'), cases.replace(/  - id: TC-PAY-001[\s\S]*?(?=  - id: TC-ADM-001)/, ''));
  const r = runNode(EXPORT, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /requirement REQ-PAY-001 has no test case/);
});

test('without a project key, export still writes features and CSV but no bulk JSON', () => {
  const { root, out } = project({ projectKey: null });
  const r = runNode(EXPORT, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no xray-tests\.json \(set xray\.project_key/);
  assert.ok(!fs.existsSync(path.join(out, 'xray', 'xray-tests.json')));
  assert.equal(runNode(EXPORT, ['--target', 'mini-shop', '--root', root], { env: { XRAY_PROJECT_KEY: 'ENV' } }).status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(out, 'xray', 'xray-tests.json'), 'utf8'))[0].fields.project.key, 'ENV');
});

test('publish: the dry run sends nothing; a wrong preview_id is refused; the right one imports and saves the keys', async () => {
  const { root, out } = project();
  runNode(EXPORT, ['--target', 'mini-shop', '--root', root]);
  const dry = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^publish-xray: DRY RUN, nothing sent\. 4 tests \(3 Manual, 1 Cucumber\), 3 linked to Jira requirements, 1 requirement\(s\) without a Jira key\. preview_id [0-9a-f]{16}/);
  const id = JSON.parse(fs.readFileSync(path.join(out, 'xray', 'publish-preview.json'), 'utf8')).preview_id;
  const mock = await startMockXray();
  try {
    const env = { XRAY_BASE_URL: mock.url, XRAY_CLIENT_ID: 'id', XRAY_CLIENT_SECRET: 'secret' };
    const wrong = await runNodeAsync(PUBLISH, ['--target', 'mini-shop', '--root', root, '--confirm', '0000000000000000'], { env });
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /does not match/);
    assert.equal(mock.calls.length, 0, 'refused before any request');
    const real = await runNodeAsync(PUBLISH, ['--target', 'mini-shop', '--root', root, '--confirm', id], { env });
    assert.equal(real.status, 0, real.stderr);
    assert.match(real.stdout, /import job job-1 successful: 4 test\(s\) created, 0 error\(s\)/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, 'xray', 'xray-keys.json'), 'utf8')), { 'TC-AUTH-001': 'QA-101', 'TC-AUTH-002': 'QA-102', 'TC-PAY-001': 'QA-103', 'TC-ADM-001': 'QA-104' });
    assert.ok(!fs.readFileSync(path.join(out, 'ledger.jsonl'), 'utf8').includes('secret'), 'credentials never reach the ledger');
  } finally {
    await mock.close();
  }
});

test('results: export from a Playwright report, dry run, then import into a Test Execution', async () => {
  const { root, out } = project();
  fs.mkdirSync(path.join(out, 'xray'), { recursive: true });
  fs.writeFileSync(path.join(out, 'xray', 'xray-keys.json'), JSON.stringify({ 'TC-AUTH-001': 'QA-101', 'TC-ADM-001': 'QA-104' }));
  const report = path.join(root, 'report.json');
  fs.writeFileSync(
    report,
    JSON.stringify({
      suites: [
        {
          file: 'login.spec.ts',
          specs: [
            { title: 'login @TC-AUTH-001', tests: [{ expectedStatus: 'passed', status: 'expected', results: [{ status: 'passed', duration: 10, startTime: '2026-11-09T10:00:00.000Z' }] }] },
            { title: 'report @TC-ADM-001', tests: [{ expectedStatus: 'failed', status: 'expected', results: [{ status: 'failed', duration: 10, startTime: '2026-11-09T10:00:01.000Z' }] }] },
            { title: 'new @TC-PAY-001', tests: [{ expectedStatus: 'passed', status: 'expected', results: [] }] },
          ],
        },
      ],
    }),
  );
  const ex = runNode(EXPORT, ['--target', 'mini-shop', '--root', root, '--results', report]);
  assert.equal(ex.status, 0, ex.stderr);
  assert.match(ex.stdout, /2 test result\(s\) → xray\/xray-results\.json; 1 case\(s\) without an Xray key/);
  const dry = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root, '--results']);
  assert.match(dry.stdout, /2 results \(1 PASSED, 1 FAILED\)/);
  const id = JSON.parse(fs.readFileSync(path.join(out, 'xray', 'publish-preview-results.json'), 'utf8')).preview_id;
  const mock = await startMockXray();
  try {
    const r = await runNodeAsync(PUBLISH, ['--target', 'mini-shop', '--root', root, '--results', '--confirm', id], { env: { XRAY_BASE_URL: mock.url, XRAY_CLIENT_ID: 'id', XRAY_CLIENT_SECRET: 'secret' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Test Execution QA-900/);
  } finally {
    await mock.close();
  }
});

test('publish before export explains what to run first', () => {
  const { root } = project();
  const r = runNode(PUBLISH, ['--target', 'mini-shop', '--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run export-xray first/);
});
