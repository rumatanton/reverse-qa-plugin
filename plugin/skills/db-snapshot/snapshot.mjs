#!/usr/bin/env node
// db-snapshot: record every table (exact counts plus rows) before and after a flow, then diff the two. The diff is
// the evidence for "what this workflow writes to the database".
//   node snapshot.mjs --target <name> --label <label> [--max-rows 5000]     take a snapshot
//   node snapshot.mjs --target <name> --diff <before> <after>              compare two snapshots
//   exit 0 = done, 1 = usage or configuration problem
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { dbConfig, schema, counts, rows } from '../../lib/db.mjs';
import { appendLedger, outputDir, writeOutput } from '../../lib/ledger.mjs';

export function safeLabel(label) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(label ?? '')) throw new Error(`label "${label}" must be letters, digits, dot, dash or underscore`);
  return label;
}

export function takeSnapshot(target, label, { maxRows = 5000 } = {}) {
  safeLabel(label);
  const defs = schema(target);
  const n = counts(target, Object.keys(defs));
  const tables = {};
  for (const [t, def] of Object.entries(defs)) {
    const truncated = n[t] > maxRows;
    tables[t] = { count: n[t], primaryKey: def.primaryKey, columns: def.columns, truncated, rows: rows(target, t, def, { limit: maxRows }) };
  }
  const snap = { label, database: dbConfig(target).name, tables };
  writeOutput(target.dir, `snapshots/${label}.json`, `${JSON.stringify(snap, null, 2)}\n`);
  appendLedger(target.dir, 'db-snapshot', { label, counts: n });
  return snap;
}

const keyOf = (row, pk) => (pk.length ? JSON.stringify(pk.map((c) => row[c])) : JSON.stringify(row));

/** Compare two snapshots table by table: rows added, removed and changed (by primary key, or whole row without one). */
export function diffSnapshots(a, b) {
  const tables = {};
  for (const t of [...new Set([...Object.keys(a.tables), ...Object.keys(b.tables)])].sort()) {
    const before = a.tables[t] ?? { count: 0, rows: [], primaryKey: [] };
    const after = b.tables[t] ?? { count: 0, rows: [], primaryKey: [] };
    const pk = after.primaryKey?.length ? after.primaryKey : before.primaryKey ?? [];
    const left = new Map();
    for (const r of before.rows) {
      const k = keyOf(r, pk);
      left.set(k, [...(left.get(k) ?? []), r]);
    }
    const added = [];
    const changed = [];
    for (const r of after.rows) {
      const k = keyOf(r, pk);
      const match = left.get(k)?.shift();
      if (!match) {
        added.push(r);
        continue;
      }
      if (!left.get(k).length) left.delete(k);
      const fields = Object.keys({ ...match, ...r }).filter((c) => JSON.stringify(match[c]) !== JSON.stringify(r[c]));
      if (fields.length) changed.push({ key: Object.fromEntries(pk.map((c) => [c, r[c]])), changes: Object.fromEntries(fields.map((c) => [c, [match[c] ?? null, r[c] ?? null]])) });
    }
    const removed = [...left.values()].flat();
    if (added.length || removed.length || changed.length || before.count !== after.count) {
      tables[t] = { count_before: before.count, count_after: after.count, added, removed, changed, partial: Boolean(before.truncated || after.truncated) };
    }
  }
  return { before: a.label, after: b.label, tables };
}

export function diffMarkdown(d) {
  const lines = [`# Database diff: ${d.before} → ${d.after}`, ''];
  const names = Object.keys(d.tables);
  if (names.length === 0) lines.push('No table changed.');
  for (const t of names) {
    const x = d.tables[t];
    lines.push(`## ${t} (${x.count_before} → ${x.count_after} rows)${x.partial ? ' (partial: row limit reached)' : ''}`, '');
    for (const r of x.added) lines.push(`- added: \`${JSON.stringify(r)}\``);
    for (const r of x.removed) lines.push(`- removed: \`${JSON.stringify(r)}\``);
    for (const c of x.changed) lines.push(`- changed ${JSON.stringify(c.key)}: ${Object.entries(c.changes).map(([k, [o, n]]) => `${k} ${JSON.stringify(o)} → ${JSON.stringify(n)}`).join(', ')}`);
    lines.push('');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

export function diffSummary(d) {
  const parts = Object.entries(d.tables).map(([t, x]) => {
    const bits = [x.added.length && `+${x.added.length}`, x.removed.length && `-${x.removed.length}`, x.changed.length && `~${x.changed.length}`].filter(Boolean);
    return `${t} ${bits.join(' ') || `${x.count_before}→${x.count_after}`}`;
  });
  return `db-snapshot: ${d.before} → ${d.after}: ${parts.length ? parts.join(', ') : 'no table changed'}`;
}

function readSnap(target, label) {
  const file = path.join(outputDir(target.dir), 'snapshots', `${safeLabel(label)}.json`);
  if (!fs.existsSync(file)) throw new Error(`no snapshot "${label}" at ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function compare(target, beforeLabel, afterLabel) {
  const d = diffSnapshots(readSnap(target, beforeLabel), readSnap(target, afterLabel));
  writeOutput(target.dir, `snapshots/${beforeLabel}__${afterLabel}.diff.json`, `${JSON.stringify(d, null, 2)}\n`);
  writeOutput(target.dir, `snapshots/${beforeLabel}__${afterLabel}.diff.md`, diffMarkdown(d));
  appendLedger(target.dir, 'db-snapshot-diff', { before: beforeLabel, after: afterLabel, tables: Object.keys(d.tables) });
  return d;
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { target: { type: 'string' }, root: { type: 'string' }, label: { type: 'string' }, diff: { type: 'boolean' }, 'max-rows': { type: 'string' } },
  });
  if (!values.target || (!values.label && !(values.diff && positionals.length === 2))) {
    process.stderr.write('usage: snapshot.mjs --target <name> (--label <label> | --diff <before> <after>) [--max-rows N]\n');
    return 1;
  }
  try {
    const target = loadTarget(projectRoot(values.root), values.target);
    if (values.diff) {
      process.stdout.write(`${diffSummary(compare(target, positionals[0], positionals[1]))}\n`);
    } else {
      const snap = takeSnapshot(target, values.label, { maxRows: Number(values['max-rows'] ?? 5000) });
      const total = Object.values(snap.tables).reduce((a, t) => a + t.count, 0);
      process.stdout.write(`db-snapshot: ${values.label}: ${Object.keys(snap.tables).length} tables, ${total} rows\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`db-snapshot: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
