// Semgrep and Psalm, live in Docker: both run on copied source and produce normalized findings; Psalm separates
// sanitized input (mini-shop) from request input concatenated into SQL (a planted one-file case).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempProject } from '../helpers.mjs';
import { dockerAvailable } from '../../lib/docker.mjs';
import { loadTarget } from '../../lib/target.mjs';
import { runSemgrep, runPsalm, normalizeSemgrep, normalizePsalm } from '../../skills/run-security-scans/security.mjs';

const skip = !dockerAvailable() && 'Docker engine not running';

test('Semgrep runs on the copied source and reports findings with file and line', { skip, timeout: 1_200_000 }, () => {
  const t = loadTarget(tempProject().root, 'mini-shop');
  const findings = normalizeSemgrep(runSemgrep(t));
  assert.ok(Array.isArray(findings));
  for (const f of findings) assert.ok(f.file && !f.file.startsWith('/src/') && Number.isInteger(f.line), JSON.stringify(f));
});

test('Psalm sees no tainted SQL in mini-shop: every input there is escaped or cast to int', { skip, timeout: 1_200_000 }, () => {
  const t = loadTarget(tempProject().root, 'mini-shop');
  const findings = normalizePsalm(runPsalm(t));
  assert.deepEqual(findings.filter((f) => f.rule === 'TaintedSql'), []);
});

test('Psalm flags request input concatenated into SQL (a one-file planted case)', { skip, timeout: 1_200_000 }, () => {
  const { root } = tempProject();
  const src = fs.mkdtempSync(path.join(root, 'src-'));
  fs.writeFileSync(path.join(src, 'item.php'), '<?php\n$db = new mysqli("localhost", "u", "p", "d");\n$id = $_GET["id"];\n$db->query("SELECT * FROM items WHERE id = " . $id);\n');
  const t = loadTarget(root, 'mini-shop');
  t.sourceDir = src;
  const sql = normalizePsalm(runPsalm(t)).filter((f) => f.rule === 'TaintedSql');
  assert.deepEqual(sql.map((f) => `${f.file}:${f.line}`), ['item.php:4']);
});
