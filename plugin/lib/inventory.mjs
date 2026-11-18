// Normalize a rule pack's raw facts (rules/CONTRACT.md) into inventory.json: pages and includes, SQL verbs and
// tables, the CRUD matrix, session guards, redirect risks, outbound hosts, forms, endpoints and the data model.
// Stack-independent: every pack's output goes through here. Pages have three possible sources, merged by path: the
// pack (a parsed stack where a file is a page), an OpenAPI spec, and a crawl of the running app.
import path from 'node:path';
import { toCsv } from './csv.mjs';

const P = path.posix;
const LIST_KEYS = ['includes', 'session', 'superglobals', 'sql', 'uploads', 'urls', 'calls', 'functions', 'redirects', 'js_redirects', 'forms'];

/** Shape check for a pack's raw output. Returns a list of problems (empty = valid). */
export function validateRaw(raw) {
  const problems = [];
  if (!raw || typeof raw !== 'object') return ['output is not a JSON object'];
  if (typeof raw.pack !== 'string') problems.push('pack: missing');
  if (!Array.isArray(raw.files)) return [...problems, 'files: not an array'];
  for (const f of raw.files) {
    if (typeof f.path !== 'string' || f.path.includes('\\')) problems.push(`file path invalid: ${f.path}`);
    if (f.parse_error) continue;
    for (const k of LIST_KEYS) if (!Array.isArray(f[k])) problems.push(`${f.path}: ${k} is not an array`);
    for (const k of LIST_KEYS) for (const item of f[k] ?? []) if (!Number.isInteger(item.line)) problems.push(`${f.path}: ${k} item without a line`);
    if (f.routes !== undefined && !Array.isArray(f.routes)) problems.push(`${f.path}: routes is not an array`);
    for (const r of Array.isArray(f.routes) ? f.routes : []) if (!Number.isInteger(r.line) || typeof r.path !== 'string') problems.push(`${f.path}: routes item without a line or a path`);
  }
  if (raw.pages !== undefined && !['files', 'none'].includes(raw.pages)) problems.push('pages: must be "files" or "none"');
  return problems;
}

const ident = '[`"]?([A-Za-z_][\\w$]*)[`"]?(?:\\s*\\.\\s*[`"]?([A-Za-z_][\\w$]*)[`"]?)?';
const tableName = (m) => m[2] ?? m[1];
const STOP = /\b(WHERE|JOIN|INNER|LEFT|RIGHT|CROSS|NATURAL|GROUP|ORDER|LIMIT|HAVING|UNION|ON|USING|SET|VALUES)\b|\)|;|$/i;

function fromTables(sql) {
  const out = [];
  const re = /\bFROM\s+/gi;
  let m;
  while ((m = re.exec(sql))) {
    const rest = sql.slice(m.index + m[0].length);
    const stop = rest.search(STOP);
    for (const part of rest.slice(0, stop === -1 ? undefined : stop).split(',')) {
      const t = part.trim().match(new RegExp(`^${ident}`));
      if (t && !/^(DUAL|SELECT)$/i.test(tableName(t))) out.push(tableName(t));
    }
  }
  for (const j of sql.matchAll(new RegExp(`\\bJOIN\\s+${ident}`, 'gi'))) out.push(tableName(j));
  return out;
}

/** Verb plus the tables a statement writes and reads. */
export function classifySql(text) {
  const verb = text.match(/^\s*\(?\s*(SELECT|INSERT|UPDATE|DELETE|REPLACE)\b/i)?.[1].toUpperCase() ?? 'OTHER';
  let writes = [];
  let reads = [];
  let m;
  if ((verb === 'INSERT' || verb === 'REPLACE') && (m = text.match(new RegExp(`\\bINTO\\s+${ident}`, 'i')))) {
    writes = [tableName(m)];
    reads = fromTables(text.slice(m.index + m[0].length));
  } else if (verb === 'UPDATE' && (m = text.match(new RegExp(`^\\s*UPDATE\\s+(?:LOW_PRIORITY\\s+|IGNORE\\s+)*${ident}`, 'i')))) {
    writes = [tableName(m)];
    reads = fromTables(text);
  } else if (verb === 'DELETE' && (m = text.match(new RegExp(`\\bFROM\\s+${ident}`, 'i')))) {
    writes = [tableName(m)];
    reads = fromTables(text.slice(m.index + m[0].length));
  } else if (verb === 'SELECT') {
    reads = fromTables(text);
  }
  const uniq = (a) => [...new Set(a)];
  return { verb, writes: uniq(writes), reads: uniq(reads).filter((t) => !writes.includes(t) || verb === 'SELECT') };
}

const CRUD_OF = { INSERT: 'C', REPLACE: 'C', UPDATE: 'U', DELETE: 'D' };

/** Resolve an include target the way PHP does for relative paths: the including file's folder, then the root. */
export function resolveInclude(from, target, known) {
  if (!target || target.includes('?')) return null;
  const clean = target.replace(/\\/g, '/');
  for (const cand of [P.normalize(P.join(P.dirname(from), clean)), P.normalize(clean.replace(/^\.\//, ''))]) {
    if (known.has(cand)) return cand;
  }
  return null;
}

function host(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Resolve a form action or redirect URL relative to the file that holds it. Absolute URLs stay absolute. */
export function resolveTarget(from, url) {
  if (!url) return from; // an empty or missing action posts back to the same page
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const noQuery = url.split(/[?#]/)[0];
  if (!noQuery) return from;
  return P.normalize(noQuery.startsWith('/') ? noQuery.replace(/^\/+/, '') : P.join(P.dirname(from), noQuery));
}

/**
 * Build the inventory.
 *   raw        rule-pack output (validated)
 *   dump       parseDump() result for the seed dump, or null
 *   options    { target, commit, allowedHosts, basePath, outputBuffering, endpoints }
 *              basePath = URL path prefix of the app (e.g. "shop"); outputBuffering = php.ini output_buffering
 *              in bytes on the runtime (decides whether output before a redirect stops it), null when unknown;
 *              endpoints = pages seen outside the source: from an OpenAPI spec (lib/openapi.mjs) and from a crawl of
 *              the running app (lib/crawl.mjs), each { path, methods, params, source, evidence, ... }
 */
export function normalize(raw, dump, { target = null, commit = null, allowedHosts = ['localhost', '127.0.0.1'], basePath = '', outputBuffering = null, endpoints = [] } = {}) {
  const files = structuredClone(raw.files); // never mutate the caller's raw output (scan-repo saves it verbatim)
  const byPath = new Map(files.map((f) => [f.path, f]));
  const known = new Set(byPath.keys());
  const includedBy = new Map();

  for (const f of files) {
    for (const inc of f.includes ?? []) {
      inc.resolved = resolveInclude(f.path, inc.target, known);
      if (inc.resolved) includedBy.set(inc.resolved, [...(includedBy.get(inc.resolved) ?? []), f.path]);
    }
  }
  const closure = (p, seen = new Set()) => {
    for (const inc of byPath.get(p)?.includes ?? []) {
      if (inc.resolved && !seen.has(inc.resolved)) {
        seen.add(inc.resolved);
        closure(inc.resolved, seen);
      }
    }
    return seen;
  };
  const outputs = (p) => (byPath.get(p)?.top_level_html_bytes ?? 0) > 0;

  // SQL
  const sql = [];
  for (const f of files) {
    for (const s of f.sql ?? []) sql.push({ file: f.path, line: s.line, text: s.text, ...classifySql(s.text) });
  }

  // tables (from the dump) and who touches them
  const dumpTables = dump?.tables ?? {};
  const canon = new Map(Object.keys(dumpTables).map((t) => [t.toLowerCase(), t]));
  const name = (t) => canon.get(t.toLowerCase()) ?? t;
  const crud = new Map(); // "file\ttable" -> { C,R,U,D, lines }
  const touch = (file, table, letter, line) => {
    const key = `${file}\t${name(table)}`;
    const row = crud.get(key) ?? { file, table: name(table), C: '', R: '', U: '', D: '', lines: [] };
    row[letter] = letter;
    if (!row.lines.includes(line)) row.lines.push(line);
    crud.set(key, row);
  };
  for (const s of sql) {
    for (const t of s.writes) touch(s.file, t, CRUD_OF[s.verb], s.line);
    if (s.verb === 'REPLACE') for (const t of s.writes) touch(s.file, t, 'U', s.line);
    for (const t of s.reads) touch(s.file, t, 'R', s.line);
  }
  const crudRows = [...crud.values()].sort((a, b) => a.file.localeCompare(b.file) || a.table.localeCompare(b.table));
  const tables = {};
  for (const [t, def] of Object.entries(dumpTables)) {
    tables[t] = { ...def, used_by: { C: [], R: [], U: [], D: [] } };
  }
  const undeclared = new Set();
  for (const row of crudRows) {
    if (!tables[row.table]) {
      undeclared.add(row.table);
      continue;
    }
    for (const l of 'CRUD') if (row[l] && !tables[row.table].used_by[l].includes(row.file)) tables[row.table].used_by[l].push(row.file);
  }

  // URLs and hosts
  const allowed = new Set(allowedHosts.map((h) => h.toLowerCase()));
  const outboundHosts = new Map();
  const assetHosts = new Map();
  const note = (map, h, ref) => {
    if (!h || allowed.has(h)) return;
    map.set(h, [...(map.get(h) ?? []), ref]);
  };
  for (const f of files) {
    for (const u of f.urls ?? []) {
      const ref = `${f.path}:${u.line}`;
      if (u.context === 'form-action' || u.context === 'php' || u.context === 'code') note(outboundHosts, host(u.url), ref);
      else note(assetHosts, host(u.url), ref);
    }
    for (const r of f.redirects ?? []) note(outboundHosts, host(r.url), `${f.path}:${r.line}`);
  }
  for (const h of outboundHosts.keys()) assetHosts.delete(h);

  // forms
  const forms = [];
  for (const f of files) {
    for (const form of f.forms ?? []) {
      forms.push({ file: f.path, line: form.line, method: form.method, enctype: form.enctype, action: form.action, target: resolveTarget(f.path, form.action), fields: form.fields });
    }
  }

  // redirect risks: no exit after the header() call, or output sent before it (headers already sent)
  const redirectRisks = [];
  for (const f of files) {
    for (const r of f.redirects ?? []) {
      let outputBytes = 0;
      const outputSources = [];
      for (const p of r.preceded_by ?? []) {
        if (p.kind === 'html' && !p.blank) {
          outputBytes += p.bytes ?? 0;
          outputSources.push(`${f.path}:${p.line}`);
        } else if (p.kind === 'echo') outputSources.push(`${f.path}:${p.line}`);
        else if (p.kind === 'include') {
          const inc = resolveInclude(f.path, p.target, known);
          if (inc && outputs(inc)) {
            outputBytes += byPath.get(inc).top_level_html_bytes;
            outputSources.push(`${inc} (included at ${f.path}:${p.line})`);
          }
        }
      }
      const afterOutput = outputSources.length > 0;
      const codeFollows = !r.exits && r.code_follows !== false; // a redirect without exit as the last statement is harmless
      if (codeFollows || afterOutput) {
        // With output buffering, PHP still sends the redirect until the buffer fills; past it, headers are already sent
        // and the browser gets the page (HTTP 200). null = the buffer size is unknown (runtime.output_buffering unset).
        const headersSent = !afterOutput ? false : outputBuffering === null ? null : outputBytes > outputBuffering;
        const kinds = [codeFollows && 'execution-after-redirect', headersSent && 'headers-already-sent', afterOutput && headersSent === null && 'output-before-redirect'].filter(Boolean);
        redirectRisks.push({ file: f.path, line: r.line, url: r.url, kinds, exits: r.exits, code_follows: codeFollows, after_output: afterOutput, output_bytes: outputBytes, headers_already_sent: headersSent, output_sources: outputSources });
      }
    }
  }

  // pages and endpoints. With pages "none" (the generic pack) a source file is not a page: pages come from `endpoints`.
  const fileIsPage = raw.pages !== 'none';
  const pagePaths = fileIsPage ? files.filter((f) => !includedBy.has(f.path) && !f.parse_error).map((f) => f.path) : [];
  const formsTo = new Map();
  for (const form of forms) formsTo.set(form.target, [...(formsTo.get(form.target) ?? []), form]);
  const pages = pagePaths.map((p) => {
    const scope = [p, ...closure(p)];
    const facts = (k) => scope.flatMap((s) => (byPath.get(s)?.[k] ?? []).map((x) => ({ ...x, file: s })));
    const params = {};
    for (const g of facts('superglobals')) {
      const k = g.name.replace(/^_/, '');
      params[k] ??= [];
      if (!params[k].includes(g.key)) params[k].push(g.key);
    }
    const incoming = formsTo.get(p) ?? [];
    const methods = ['GET'];
    if (params.POST || params.FILES || incoming.some((x) => x.method === 'POST')) methods.push('POST');
    const touched = crudRows.filter((r) => scope.includes(r.file));
    return {
      path: p,
      url: basePath ? `${basePath.replace(/\/+$/, '')}/${p}` : p,
      includes: [...closure(p)].sort(),
      methods,
      params,
      guards: facts('session').filter((s) => s.op === 'check').map(({ key, file, line }) => ({ key, file, line })),
      session_writes: facts('session').filter((s) => s.op === 'write').map(({ key, file, line }) => ({ key, file, line })),
      session_unsets: facts('session').filter((s) => s.op === 'unset').map(({ key, file, line }) => ({ key, file, line })),
      reads: [...new Set(touched.filter((r) => r.R).map((r) => r.table))].sort(),
      writes: [...new Set(touched.filter((r) => r.C || r.U || r.D).map((r) => r.table))].sort(),
      uploads: facts('uploads').map(({ file, line }) => ({ file, line })),
      forms_targeting: incoming.map(({ file, line, method }) => ({ file, line, method })),
      redirects: facts('redirects').map(({ file, line, url, exits }) => ({ file, line, url, exits })),
      js_redirects: facts('js_redirects').map(({ file, line, url }) => ({ file, line, url })),
      redirect_risks: redirectRisks.filter((r) => scope.includes(r.file)).map(({ file, line }) => `${file}:${line}`),
      sources: ['pack'],
    };
  });
  mergeEndpoints(pages, endpoints, basePath);
  const routeHints = files.flatMap((f) => (f.routes ?? []).map((r) => ({ file: f.path, line: r.line, method: r.method ?? 'ANY', path: r.path, framework: r.framework ?? null, matched: pages.some((p) => samePath(p.path, r.path)) })));

  const sessionKeys = {};
  for (const f of files) {
    for (const s of f.session ?? []) {
      if (s.key === '*' || s.key === '?') continue;
      sessionKeys[s.key] ??= { check: [], write: [], read: [], unset: [] };
      sessionKeys[s.key][s.op].push(`${f.path}:${s.line}`);
    }
  }

  const inventory = {
    target,
    commit,
    pack: { name: raw.pack, version: raw.pack_version ?? null, language_version: raw.language_version ?? null },
    summary: {
      files: files.length,
      pages: pages.length,
      includes: fileIsPage ? files.length - pagePaths.length - files.filter((f) => f.parse_error).length : 0,
      pages_from: Object.fromEntries(['pack', 'openapi', 'crawl'].map((k) => [k, pages.filter((p) => p.sources.includes(k)).length])),
      route_hints: routeHints.length,
      route_hints_unmatched: routeHints.filter((r) => !r.matched).length,
      parse_errors: files.filter((f) => f.parse_error).length,
      sql_statements: sql.length,
      tables: Object.keys(tables).length,
      forms: forms.length,
      uploads: files.reduce((n, f) => n + (f.uploads?.length ?? 0), 0),
      session_keys: Object.keys(sessionKeys).sort(),
      outbound_hosts: [...outboundHosts.keys()].sort(),
      redirect_risks: redirectRisks.length,
    },
    pages,
    includes: [...includedBy.entries()].map(([p, by]) => ({ path: p, included_by: [...new Set(by)].sort(), outputs_html: outputs(p) })).sort((a, b) => a.path.localeCompare(b.path)),
    parse_errors: files.filter((f) => f.parse_error).map((f) => ({ file: f.path, message: f.parse_error })),
    session_keys: sessionKeys,
    sql,
    tables,
    undeclared_tables: [...undeclared].sort(),
    forms,
    redirect_risks: redirectRisks,
    outbound_hosts: Object.fromEntries([...outboundHosts.entries()].sort()),
    asset_hosts: Object.fromEntries([...assetHosts.entries()].sort()),
    security_calls: files.flatMap((f) => (f.calls ?? []).map((c) => ({ file: f.path, line: c.line, name: c.name }))),
    functions: files.flatMap((f) => (f.functions ?? []).map((fn) => ({ file: f.path, line: fn.line, name: fn.name }))),
    route_hints: routeHints,
  };
  return { inventory, crudRows };
}

/** A path with its parameters blanked, so /orders/{id}, /orders/:id and /orders/<int:id> compare equal. */
export function pathShape(p) {
  return String(p ?? '').replace(/^\/+|\/+$/g, '').split('/').map((seg) => (/^(\{.*\}|:.+|<.+>|\[.+\])$/.test(seg) ? '{}' : seg.toLowerCase())).join('/');
}
const samePath = (a, b) => pathShape(a) === pathShape(b);

/**
 * The page a folder address serves: "admin/" is "admin/index.php" when the source has exactly one index file there.
 * Without this a crawl would list the folder and its index as two pages.
 */
function dirIndexOf(pages, p) {
  if (p !== '' && !p.endsWith('/')) return undefined;
  const hits = pages.filter((x) => x.sources?.includes('pack') && x.path.startsWith(p) && /^index\.\w+$/.test(x.path.slice(p.length)));
  return hits.length === 1 ? hits[0] : undefined;
}

/**
 * Merge endpoints from outside the source (OpenAPI spec, crawl) into the page list, in place. An endpoint whose path
 * matches a page adds to it (methods, parameters, guards, what each role got); the others become new pages. Every
 * page keeps the same keys, so tests and reports read them the same way whatever the source.
 */
export function mergeEndpoints(pages, endpoints, basePath = '') {
  const union = (a = [], b = []) => [...new Set([...a, ...b])];
  for (const e of endpoints ?? []) {
    let page = pages.find((p) => p.path === e.path) ?? dirIndexOf(pages, e.path) ?? pages.find((p) => samePath(p.path, e.path));
    if (page && page.path !== e.path && (e.path === '' || e.path.endsWith('/'))) page.aliases = union(page.aliases, [e.path]); // the folder's address serves this page
    if (!page) {
      page = { path: e.path, url: basePath ? `${basePath.replace(/\/+$/, '')}/${e.path}` : e.path, includes: [], methods: [], params: {}, guards: [], session_writes: [], session_unsets: [], reads: [], writes: [], uploads: [], forms_targeting: [], redirects: [], js_redirects: [], redirect_risks: [], sources: [] };
      pages.push(page);
    }
    page.methods = union(page.methods, e.methods);
    for (const [k, v] of Object.entries(e.params ?? {})) page.params[k] = union(page.params[k], v);
    for (const g of e.guards ?? []) if (!page.guards.some((x) => x.key === g.key && x.file === g.file && x.line === g.line)) page.guards.push(g);
    if (!page.sources.includes(e.source)) page.sources.push(e.source);
    page.evidence = union(page.evidence, [e.evidence].filter(Boolean));
    for (const k of ['example_path', 'example_query', 'seen_query', 'title']) if (e[k] && !page[k]) page[k] = e[k];
    if (e.operations) page.operations = e.operations;
    if (e.observed) page.observed = e.observed;
    if (e.reachable_by) page.reachable_by = e.reachable_by;
    if (e.forms?.length) page.forms = e.forms;
  }
  pages.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return pages;
}

export function crudCsv(crudRows) {
  return toCsv(crudRows.map((r) => ({ ...r, lines: r.lines.join(' ') })), ['file', 'table', 'C', 'R', 'U', 'D', 'lines']);
}

/** Mermaid ER diagram from the dump's tables and foreign keys. */
export function erMermaid(tables) {
  const safe = (s) => s.replace(/[^\w()[\]-]/g, '_');
  const lines = ['erDiagram'];
  for (const [t, def] of Object.entries(tables).sort()) {
    lines.push(`  ${safe(t)} {`);
    const fkCols = new Set(def.foreignKeys.map((f) => f.column));
    for (const c of def.columns) {
      const keys = [def.primaryKey.includes(c.name) && 'PK', fkCols.has(c.name) && 'FK'].filter(Boolean).join(',');
      lines.push(`    ${safe(c.type)} ${safe(c.name)}${keys ? ` ${keys}` : ''}`);
    }
    lines.push('  }');
  }
  for (const [t, def] of Object.entries(tables).sort()) {
    for (const fk of def.foreignKeys) lines.push(`  ${safe(fk.refTable)} ||--o{ ${safe(t)} : "${fk.column}"`);
  }
  return `${lines.join('\n')}\n`;
}
