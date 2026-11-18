// The Xray client and tool logic against a mock Xray Cloud, then the real MCP server over stdio with the SDK client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { XrayClient, configFromEnv, describeConfig, previewTests, publishTests, previewResults, publishResults } from '../../mcp/xray/core.mjs';
import { startMockXray } from '../xray-mock.mjs';
import { PLUGIN } from '../helpers.mjs';

const OFFICIAL = JSON.parse(fs.readFileSync(path.join(PLUGIN, 'tests', 'fixtures', 'xray', 'official-bulk-example.json'), 'utf8'));

test('configFromEnv ignores unset ${user_config.*} placeholders and describeConfig never shows secrets', () => {
  const cfg = configFromEnv({ XRAY_CLIENT_ID: '${user_config.xray_client_id}', XRAY_CLIENT_SECRET: '', XRAY_PROJECT_KEY: 'QA' });
  assert.deepEqual(cfg, { baseUrl: 'https://xray.cloud.getxray.app/api/v2', clientId: '', clientSecret: '', projectKey: 'QA' });
  const shown = describeConfig({ ...cfg, clientId: 'id', clientSecret: 'very-secret' });
  assert.equal(shown.credentials, true);
  assert.ok(!JSON.stringify(shown).includes('very-secret'));
});

test('client: authenticate, bulk import, poll the job, then created keys come back in payload order', async () => {
  const mock = await startMockXray({ failElements: [1] });
  try {
    const client = new XrayClient({ baseUrl: mock.url, clientId: 'id', clientSecret: 'secret', pollMs: 5 });
    const preview = previewTests(OFFICIAL);
    assert.equal(preview.ready, true);
    assert.deepEqual(preview.by_type, { Cucumber: 1, Manual: 1, Generic: 1 });
    const r = await publishTests(client, OFFICIAL, preview.preview_id);
    assert.equal(r.status, 'partially_successful');
    assert.deepEqual(r.keys, ['QA-101', null, 'QA-103'], 'the rejected element keeps its place as null');
    assert.equal(mock.calls.filter((c) => c.url.endsWith('/status')).length, 2, 'polled until done');
    assert.equal(mock.calls[0].url, '/api/v2/authenticate');
    assert.ok(mock.calls.slice(1).every((c) => c.auth === 'Bearer tok-123'));
  } finally {
    await mock.close();
  }
});

test('publish refuses a payload that differs from the preview, or an invalid one, before any network call', async () => {
  const mock = await startMockXray();
  try {
    const client = new XrayClient({ baseUrl: mock.url, clientId: 'id', clientSecret: 'secret' });
    const preview = previewTests(OFFICIAL);
    const changed = structuredClone(OFFICIAL);
    changed[0].fields.summary = 'edited after the dry run';
    await assert.rejects(publishTests(client, changed, preview.preview_id), /preview_id .* does not match/);
    await assert.rejects(publishTests(client, [{ testtype: 'Manual' }], previewTests([{ testtype: 'Manual' }]).preview_id), /refusing to import: \d+ problem/);
    assert.equal(mock.calls.length, 0);
  } finally {
    await mock.close();
  }
});

test('client: wrong credentials fail clearly; GraphQL finds tests; results import returns the Test Execution', async () => {
  const mock = await startMockXray();
  try {
    await assert.rejects(new XrayClient({ baseUrl: mock.url, clientId: 'id', clientSecret: 'nope' }).authenticate(), /HTTP 401/);
    await assert.rejects(new XrayClient({ baseUrl: mock.url }).authenticate(), /credentials are not configured/);
    const client = new XrayClient({ baseUrl: mock.url, clientId: 'id', clientSecret: 'secret' });
    assert.deepEqual(await client.findTests('project = QA'), { total: 1, tests: [{ issueId: '1000', key: 'QA-101', summary: 'Existing test', type: 'Manual' }] });
    const results = { info: { summary: 'run' }, tests: [{ testKey: 'QA-101', status: 'PASSED' }] };
    const p = previewResults(results);
    assert.deepEqual([p.ready, p.by_status], [true, { PASSED: 1 }]);
    assert.equal((await publishResults(client, results, p.preview_id)).test_execution, 'QA-900');
    assert.deepEqual(previewResults({ tests: [{ testKey: 'x', status: 'MAYBE' }] }).problems.length, 2);
  } finally {
    await mock.close();
  }
});

test('MCP server over stdio: lists its tools, validates, dry-runs, and refuses a real import without credentials', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-mcp-'));
  const file = path.join(dir, 'tests.json');
  fs.writeFileSync(file, JSON.stringify(OFFICIAL));
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('XRAY_')));
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(PLUGIN, 'mcp', 'xray', 'server.mjs')], env: { ...env, XRAY_PROJECT_KEY: 'QA' } });
  const client = new Client({ name: 'rqa-test', version: '0.0.0' });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['xray_find_tests', 'xray_import_results', 'xray_import_tests', 'xray_status', 'xray_validate_tests']);
    const text = (r) => r.content[0].text;
    assert.match(text(await client.callTool({ name: 'xray_status', arguments: {} })), /"mode": "offline \(validate and dry-run only\)"/);
    assert.match(text(await client.callTool({ name: 'xray_validate_tests', arguments: { file } })), /"valid": true/);
    const dry = JSON.parse(text(await client.callTool({ name: 'xray_import_tests', arguments: { file } })));
    assert.deepEqual([dry.dry_run, dry.ready, dry.tests], [true, true, 3]);
    const real = await client.callTool({ name: 'xray_import_tests', arguments: { file, dry_run: false, preview_id: dry.preview_id } });
    assert.equal(real.isError, true);
    assert.match(text(real), /credentials are not configured/);
    const mismatch = await client.callTool({ name: 'xray_import_tests', arguments: { json: [OFFICIAL[1]], dry_run: false, preview_id: dry.preview_id } });
    assert.match(text(mismatch), /does not match/);
  } finally {
    await client.close();
  }
});
