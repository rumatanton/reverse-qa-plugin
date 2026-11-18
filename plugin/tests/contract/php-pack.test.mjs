// Rule-pack contract (rules/CONTRACT.md): the live PHP pack, run in Docker on the mini-shop fixture, must produce
// exactly the recorded output (deterministic, no drift) and that output must satisfy the contract. The fact-level
// assertions live in tests/unit/inventory.test.mjs, which reads the same recorded file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PLUGIN, tempProject } from '../helpers.mjs';
import { dockerAvailable } from '../../lib/docker.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { runPack } from '../../skills/scan-repo/scan.mjs';
import { validateRaw } from '../../lib/inventory.mjs';

const RECORDED = path.join(PLUGIN, 'tests', 'fixtures', 'scan', 'mini-shop.raw.json');
const docker = dockerAvailable();

test('live PHP pack output equals the recorded output and passes the contract', { skip: !docker && 'Docker engine not running', timeout: 1_800_000 }, () => {
  const { root } = tempProject();
  const raw = runPack(loadTarget(root, 'mini-shop'));
  assert.deepEqual(validateRaw(raw), []);
  if (process.env.RQA_RECORD) fs.writeFileSync(RECORDED, `${JSON.stringify(raw, null, 2)}\n`);
  assert.deepEqual(raw, JSON.parse(fs.readFileSync(RECORDED, 'utf8')), 'pack output drifted: re-record with RQA_RECORD=1 only if the change is intended');
});

test('the pack reports a parse error for broken PHP instead of failing the whole scan', { skip: !docker && 'Docker engine not running', timeout: 600_000 }, () => {
  const { root } = tempProject();
  const src = fs.mkdtempSync(path.join(root, 'src-'));
  fs.writeFileSync(path.join(src, 'ok.php'), '<?php echo "fine";\n');
  fs.writeFileSync(path.join(src, 'broken.php'), '<?php if ( {\n');
  const t = loadTarget(root, 'mini-shop');
  t.sourceDir = src;
  const raw = runPack(t);
  assert.deepEqual(raw.files.map((f) => [f.path, Boolean(f.parse_error)]), [['broken.php', true], ['ok.php', false]]);
  assert.deepEqual(validateRaw(raw), []);
});
