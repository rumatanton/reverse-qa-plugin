#!/usr/bin/env node
// db-reset: drop and re-create the target database, import the seed dump over stdin, then prove the row count of
// every table equals the dump's.
//   node reset.mjs --target <name> [--root <project>]     exit 0 = reset and counts match, 2 = counts differ, 1 = error
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { projectRoot, loadTarget } from '../../lib/target.mjs';
import { parseDump, rowCounts } from '../../lib/sqldump.mjs';
import { dbConfig, execSql, importSql, counts } from '../../lib/db.mjs';
import { appendLedger } from '../../lib/ledger.mjs';

/** The seed dump text (one file or several, in order) from the target source. */
export function seedSql(target) {
  const spec = target.def.source?.seed_dump;
  if (!spec) throw new Error('target.yaml has no source.seed_dump');
  return [spec].flat().map((rel) => fs.readFileSync(path.join(target.sourceDir, rel), 'utf8'));
}

/** Tables whose live count differs from the dump's (a table missing from the database counts as a mismatch). */
export function compareCounts(expected, actual) {
  return Object.keys(expected)
    .sort()
    .filter((t) => actual[t] !== expected[t])
    .map((t) => ({ table: t, expected: expected[t], actual: actual[t] ?? null }));
}

export function resetDatabase(target) {
  const { name } = dbConfig(target);
  if (!name) throw new Error('target.yaml has no database.name');
  const files = seedSql(target);
  const started = Date.now();
  execSql(target, `DROP DATABASE IF EXISTS \`${name}\`; CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;`, { database: false });
  for (const sql of files) importSql(target, sql);
  const expected = rowCounts(parseDump(files.join('\n;\n')));
  const actual = counts(target, Object.keys(expected));
  const mismatches = compareCounts(expected, actual);
  const result = {
    database: name,
    tables: Object.keys(expected).length,
    rows: Object.values(expected).reduce((a, b) => a + b, 0),
    ms: Date.now() - started,
    expected,
    actual,
    mismatches,
  };
  appendLedger(target.dir, 'db-reset', { database: name, tables: result.tables, rows: result.rows, ms: result.ms, mismatches });
  return result;
}

export function summaryLine(r) {
  const base = `db-reset: ${r.database}: ${r.tables} tables, ${r.rows} rows imported in ${(r.ms / 1000).toFixed(1)} s`;
  if (r.mismatches.length === 0) return `${base}; every table's row count matches the dump`;
  return `${base}; COUNTS DIFFER: ${r.mismatches.map((m) => `${m.table} expected ${m.expected}, got ${m.actual}`).join('; ')}`;
}

async function main(argv) {
  const { values } = parseArgs({ args: argv, options: { target: { type: 'string' }, root: { type: 'string' } } });
  if (!values.target) {
    process.stderr.write('usage: reset.mjs --target <name> [--root <project>]\n');
    return 1;
  }
  try {
    const r = resetDatabase(loadTarget(projectRoot(values.root), values.target));
    (r.mismatches.length ? process.stderr : process.stdout).write(`${summaryLine(r)}\n`);
    return r.mismatches.length ? 2 : 0;
  } catch (err) {
    process.stderr.write(`db-reset: ${err.message}\n`);
    return 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exitCode = await main(process.argv.slice(2));
