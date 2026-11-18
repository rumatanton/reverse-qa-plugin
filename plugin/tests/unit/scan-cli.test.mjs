// scan-repo's CLI and staging, without Docker (the recorded pack output stands in for a live run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN, tempProject, runNode } from '../helpers.mjs';
import { stage, packImageTag, basePathOf } from '../../skills/scan-repo/scan.mjs';
import { loadTarget } from '../../lib/target.mjs';

const SCAN = path.join(PLUGIN, 'skills', 'scan-repo', 'scan.mjs');
const RAW = path.join(PLUGIN, 'tests', 'fixtures', 'scan', 'mini-shop.raw.json');

test('--raw writes inventory.json, crud-matrix.csv, er.mmd, the raw copy and a ledger line', () => {
  const { root, target } = tempProject();
  const r = runNode(SCAN, ['--target', 'mini-shop', '--root', root, '--raw', RAW]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^scan-repo: 8 files \(6 pages: 6 from the source, 2 includes, 0 parse errors\), 7 SQL statements, 4 tables, 2 forms, 1 uploads, session keys \[ADMIN, UID\], outbound hosts \[pay\.example\.test\], 1 redirect risks/);
  for (const f of ['inventory.json', 'crud-matrix.csv', 'er.mmd', 'scan/raw.json', 'ledger.jsonl']) assert.ok(fs.existsSync(path.join(target, 'output', f)), f);
  const ledger = fs.readFileSync(path.join(target, 'output', 'ledger.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(ledger.at(-1).step, 'scan-repo');
  assert.equal(ledger.at(-1).summary.pages, 6);
});

test('the same input gives byte-identical inventory output (deterministic)', () => {
  const { root, target } = tempProject();
  runNode(SCAN, ['--target', 'mini-shop', '--root', root, '--raw', RAW]);
  const first = fs.readFileSync(path.join(target, 'output', 'inventory.json'), 'utf8');
  runNode(SCAN, ['--target', 'mini-shop', '--root', root, '--raw', RAW]);
  assert.equal(fs.readFileSync(path.join(target, 'output', 'inventory.json'), 'utf8'), first);
});

test('pack output that breaks the contract exits 2 and writes nothing', () => {
  const { root, target } = tempProject();
  const bad = path.join(root, 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ pack: 'php', files: [{ path: 'a.php', sql: 'x' }] }));
  const r = runNode(SCAN, ['--target', 'mini-shop', '--root', root, '--raw', bad]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /breaks the contract/);
  assert.ok(!fs.existsSync(path.join(target, 'output', 'inventory.json')));
});

test('usage and unknown-target errors exit 1', () => {
  assert.equal(runNode(SCAN, []).status, 1);
  const { root } = tempProject();
  const r = runNode(SCAN, ['--target', 'nope', '--root', root]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no target definition/);
});

test('stage copies only the pack extensions, honours scan_exclude, and never touches the source', () => {
  const { root } = tempProject();
  const t = loadTarget(root, 'mini-shop');
  t.def.source.scan_exclude = ['admin'];
  const before = fs.readdirSync(t.sourceDir).length;
  const s = stage(t, 'php');
  try {
    const rels = [];
    const walk = (d, rel = '') => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(d, e.name), `${rel}${e.name}/`);
        else rels.push(`${rel}${e.name}`);
      }
    };
    walk(path.join(s.dir, 'src'));
    assert.deepEqual(rels.sort(), ['cart.php', 'checkout.php', 'db.php', 'index.php', 'login.php']);
    assert.equal(s.files, 5);
    assert.deepEqual(fs.readdirSync(path.join(s.dir, 'rules')), ['extract.php']);
  } finally {
    fs.rmSync(s.dir, { recursive: true, force: true });
  }
  assert.equal(fs.readdirSync(t.sourceDir).length, before);
});

test('packImageTag changes when any pack file changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-pack-'));
  try {
    fs.mkdirSync(path.join(dir, 'php'));
    fs.writeFileSync(path.join(dir, 'php', 'extract.php'), '<?php echo 1;');
    const a = packImageTag('php', dir);
    fs.writeFileSync(path.join(dir, 'php', 'extract.php'), '<?php echo 2;');
    const b = packImageTag('php', dir);
    assert.match(a, /^rqa-rules-php:[0-9a-f]{12}$/);
    assert.notEqual(a, b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('basePathOf takes the URL path of runtime.base_url', () => {
  assert.equal(basePathOf({ runtime: { base_url: 'http://localhost/mini-shop/' } }), 'mini-shop');
  assert.equal(basePathOf({ runtime: { base_url: 'http://localhost:8080/' } }), '');
  assert.equal(basePathOf({}), '');
});
