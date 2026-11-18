// Talk to a target's MySQL/MariaDB through `docker compose exec` on its db service (no client install, no host ports).
// Rows come back as one JSON object per line (JSON_OBJECT + mysql --raw), so NULLs, tabs and newlines survive.
import { compose, ok } from './docker.mjs';

const BINARY = /blob|binary/i;

export function dbConfig(target) {
  const d = target.def.database ?? {};
  const password = d.password_env ? process.env[d.password_env] ?? target.env[d.password_env] ?? '' : '';
  return { service: target.def.runtime?.services?.db ?? 'db', name: d.name, user: d.user ?? 'root', password };
}

function mysqlArgs(cfg, { database = true, extra = [] } = {}) {
  return ['exec', '-T', cfg.service, 'mysql', '-u', cfg.user, ...(cfg.password ? [`-p${cfg.password}`] : []), '--default-character-set=utf8mb4', ...extra, ...(database && cfg.name ? [cfg.name] : [])];
}

/** Run SQL text (statements separated by ;) and return stdout. */
export function execSql(target, sql, { database = true } = {}) {
  const cfg = dbConfig(target);
  return ok(compose(target, mysqlArgs(cfg, { database, extra: ['-B', '-N', '--raw'] }), { input: sql, timeout: 600_000 }), 'mysql').stdout;
}

/** Pipe a whole SQL file's text into the database. */
export function importSql(target, sql) {
  const cfg = dbConfig(target);
  ok(compose(target, mysqlArgs(cfg), { input: sql, timeout: 1_800_000 }), 'mysql import');
}

/** Parse --raw -N output of a single-column JSON SELECT: one JSON value per line. */
export function parseJsonLines(stdout) {
  return stdout
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const ident = (s) => `\`${String(s).replace(/`/g, '``')}\``;

/** Tables of the target database with columns (in order) and primary key. */
export function schema(target) {
  const { name } = dbConfig(target);
  const cols = parseJsonLines(
    execSql(target, `SELECT JSON_OBJECT('t', TABLE_NAME, 'c', COLUMN_NAME, 'type', DATA_TYPE, 'key', COLUMN_KEY) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${q(name)} ORDER BY TABLE_NAME, ORDINAL_POSITION;`, { database: false }),
  );
  const tables = {};
  for (const c of cols) {
    tables[c.t] ??= { columns: [], types: {}, primaryKey: [] };
    tables[c.t].columns.push(c.c);
    tables[c.t].types[c.c] = c.type;
    if (c.key === 'PRI') tables[c.t].primaryKey.push(c.c);
  }
  return tables;
}

/** Exact row count per table. */
export function counts(target, tables = Object.keys(schema(target))) {
  if (tables.length === 0) return {};
  const sql = `${tables.map((t) => `SELECT JSON_OBJECT('t', ${q(t)}, 'n', (SELECT COUNT(*) FROM ${ident(t)}))`).join(' UNION ALL ')};`;
  return Object.fromEntries(parseJsonLines(execSql(target, sql)).map((r) => [r.t, r.n]));
}

/** All rows of one table as objects, ordered by primary key (binary columns as hex). */
export function rows(target, table, def, { limit } = {}) {
  const fields = def.columns.map((c) => `${q(c)}, ${BINARY.test(def.types[c]) ? `HEX(${ident(c)})` : ident(c)}`).join(', ');
  const order = (def.primaryKey.length ? def.primaryKey : def.columns).map(ident).join(', ');
  const sql = `SELECT JSON_OBJECT(${fields}) FROM ${ident(table)} ORDER BY ${order}${limit ? ` LIMIT ${Number(limit)}` : ''};`;
  return parseJsonLines(execSql(target, sql));
}
