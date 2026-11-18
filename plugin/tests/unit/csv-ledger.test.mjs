import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toCsv, parseCsv } from '../../lib/csv.mjs';
import { appendLedger, readLedger, writeOutput } from '../../lib/ledger.mjs';
import { composeArgs, mountPath } from '../../lib/docker.mjs';

test('toCsv quotes commas, quotes, newlines and edge spaces; parseCsv round-trips', () => {
  const rows = [
    { id: 'F-1', title: 'Says "hi", then leaves', steps: 'line 1\nline 2', tags: ['a', 'b'], empty: null },
    { id: 'F-2', title: ' padded ', steps: '', tags: [], empty: undefined },
  ];
  const cols = ['id', 'title', 'steps', 'tags', 'empty'];
  const text = toCsv(rows, cols);
  assert.ok(text.startsWith('id,title,steps,tags,empty\r\n'));
  assert.ok(text.includes('"Says ""hi"", then leaves"'));
  assert.deepEqual(parseCsv(text), [
    { id: 'F-1', title: 'Says "hi", then leaves', steps: 'line 1\nline 2', tags: 'a; b', empty: '' },
    { id: 'F-2', title: ' padded ', steps: '', tags: '', empty: '' },
  ]);
});

test('parseCsv accepts LF-only files and ignores a trailing blank line', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n\n'), [{ a: '1', b: '2' }]);
});

test('ledger appends one JSON line per step and writeOutput creates folders', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rqa-ledger-'));
  appendLedger(dir, 'scan-repo', { pages: 5 });
  appendLedger(dir, 'db-reset', { ok: true });
  const lines = readLedger(dir);
  assert.deepEqual(lines.map((l) => l.step), ['scan-repo', 'db-reset']);
  assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T/);
  const file = writeOutput(dir, 'snapshots/a.json', '{}');
  assert.ok(fs.existsSync(file));
});

test('composeArgs points at the target compose file and adds profiles', () => {
  const target = { dir: path.join('x', 'targets', 't'), def: { runtime: { compose_file: 'docker-compose.yml' } } };
  const args = composeArgs(target, ['up', '-d'], { profiles: ['php8'] });
  assert.deepEqual(args.slice(0, 2), ['compose', '-f']);
  assert.ok(args[2].endsWith(path.join('targets', 't', 'docker-compose.yml')));
  assert.deepEqual(args.slice(3), ['--profile', 'php8', 'up', '-d']);
  // a path in this machine's own form: backslashes on Windows, where Docker needs them turned; none on Linux or macOS
  assert.ok(!mountPath(path.join('a', 'b')).includes('\\'));
});
