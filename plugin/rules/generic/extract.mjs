// The generic rule pack: facts any codebase has, in any language, with no parser. It runs in Node (no Docker image).
// Output follows rules/CONTRACT.md with `pages: "none"`: a source file is not a page here, so pages come from the
// running app (crawl-app) or an OpenAPI spec. What it reports, each with its line:
//   sql     SQL statements found in string literals and in XML mapper tags
//   urls    http(s) URLs (context: asset = a stylesheet, script or image reference; code = everything else)
//   routes  route hints: lines that declare an endpoint in a known framework syntax (ROUTE_PATTERNS). Hints, not
//           proof: they tell the analysts where to read and show which declared routes the crawl never reached.
// Facts, not judgments, and deterministic: files sorted by path, facts in source order.
import fs from 'node:fs';
import path from 'node:path';

export const VERSION = '1.0.0';

const LANGUAGE = {
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala', '.groovy': 'groovy', '.cs': 'csharp', '.vb': 'vb', '.fs': 'fsharp',
  '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript', '.ts': 'typescript', '.tsx': 'typescript',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust', '.php': 'php', '.swift': 'swift', '.m': 'objc', '.mm': 'objc', '.dart': 'dart',
  '.c': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.h': 'c', '.hpp': 'cpp', '.xml': 'xml', '.html': 'html', '.htm': 'html', '.jsp': 'jsp', '.jspx': 'jsp',
  '.cshtml': 'razor', '.razor': 'razor', '.vue': 'vue', '.svelte': 'svelte', '.erb': 'erb', '.twig': 'twig', '.ftl': 'freemarker',
  '.yml': 'yaml', '.yaml': 'yaml', '.json': 'json', '.properties': 'properties', '.gradle': 'gradle', '.toml': 'toml', '.ini': 'ini', '.config': 'xml',
};
const SKIP_DIRS = new Set(['.git', 'node_modules', 'vendor', 'target', 'build', 'dist', 'out', 'bin', 'obj', '.gradle', '.idea', '.vscode', 'Pods', '__pycache__', '.venv', 'venv', '.next', 'coverage']);
const SKIP_FILES = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Podfile\.lock|gradle-wrapper\.properties)$|\.min\.(js|css)$|\.map$/;
const MAX_BYTES = 1_000_000;

// A line that only declares where a document format lives (namespaces, schemas, licences) is not an outbound call.
const URL_NOISE = /xmlns|schemaLocation|DOCTYPE|w3\.org\/|apache\.org\/licenses|opensource\.org|gnu\.org\/licenses|creativecommons\.org|schemas\.(android|microsoft|xmlsoap)\.|json-schema\.org|maven\.apache\.org|java\.sun\.com|xmlns\.jcp\.org|purl\.org/i;
const ASSET_LINE = /\b(src|href)\s*=|url\(|@import|<link\b|<script\b|<img\b/i;
const ASSET_URL = /\.(css|js|mjs|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot|map)([?#]|$)/i;
const COMMENT_LINE = /^\s*(\/\/|#|\*|\/\*|<!--|--\s)/;

/**
 * Route declarations, one entry per framework syntax. `re` runs per line; `method` and `path` pick the groups;
 * `prefix` (optional) finds a class- or file-level prefix. To teach the pack a framework, add an entry and a test.
 */
export const ROUTE_PATTERNS = [
  { framework: 'spring', ext: ['.java', '.kt', '.groovy'], re: /@(Get|Post|Put|Delete|Patch|Request)Mapping\b(?:\s*\(([^)]*)\))?/, method: (m) => (m[1] === 'Request' ? (m[2] ?? '').match(/RequestMethod\.(\w+)/)?.[1] ?? 'ANY' : m[1].toUpperCase()), path: (m) => (m[2] ?? '').match(/"([^"]*)"/)?.[1] ?? '', classPrefix: true },
  { framework: 'jax-rs', ext: ['.java', '.kt'], re: /@Path\s*\(\s*"([^"]*)"\s*\)/, method: () => 'ANY', path: (m) => m[1], classPrefix: true },
  { framework: 'aspnet', ext: ['.cs'], re: /\[Http(Get|Post|Put|Delete|Patch)(?:\s*\(\s*"([^"]*)"[^)]*\))?\s*\]/, method: (m) => m[1].toUpperCase(), path: (m) => m[2] ?? '', routeAttribute: true },
  { framework: 'aspnet-minimal', ext: ['.cs'], re: /\.Map(Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/, method: (m) => m[1].toUpperCase(), path: (m) => m[2] },
  { framework: 'nestjs', ext: ['.ts'], re: /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:['"`]([^'"`]*)['"`])?\s*\)/, method: (m) => m[1].toUpperCase(), path: (m) => m[2] ?? '', controllerDecorator: true },
  { framework: 'express', ext: ['.js', '.mjs', '.cjs', '.ts'], re: /\b(?:app|router|routes|server|api|fastify)\.(get|post|put|delete|patch|all)\s*\(\s*['"`]([^'"`]+)['"`]/, method: (m) => (m[1] === 'all' ? 'ANY' : m[1].toUpperCase()), path: (m) => m[2] },
  { framework: 'flask-fastapi', ext: ['.py'], re: /@\w+(?:\.\w+)*\.(route|get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]([^)]*)/, method: (m) => (m[1] === 'route' ? (m[3].match(/methods\s*=\s*\[\s*['"](\w+)['"]/)?.[1] ?? 'GET').toUpperCase() : m[1].toUpperCase()), path: (m) => m[2] },
  { framework: 'laravel', ext: ['.php'], re: /Route::(get|post|put|delete|patch|any)\s*\(\s*['"]([^'"]+)['"]/, method: (m) => (m[1] === 'any' ? 'ANY' : m[1].toUpperCase()), path: (m) => m[2] },
  { framework: 'go-http', ext: ['.go'], re: /\.(GET|POST|PUT|DELETE|PATCH|HandleFunc|Handle)\s*\(\s*"(\/[^"]*)"/, method: (m) => (/^Handle/.test(m[1]) ? 'ANY' : m[1]), path: (m) => m[2] },
];

const join = (prefix, p) => `/${[prefix, p].map((s) => String(s ?? '').replace(/^\/+|\/+$/g, '')).filter(Boolean).join('/')}`;

/** Route hints in one file: [{ method, path, line, framework }]. */
export function routeHints(text, ext) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const p of ROUTE_PATTERNS) {
    if (!p.ext.includes(ext)) continue;
    const classLine = lines.findIndex((l) => /\b(class|interface|object)\s+\w+/.test(l) && !COMMENT_LINE.test(l));
    let prefix = '';
    let prefixLine = -1;
    if (p.classPrefix && classLine > 0) {
      for (let i = 0; i < classLine; i++) {
        const m = lines[i].match(p.re);
        if (m) { prefix = p.path(m); prefixLine = i; }
      }
    }
    if (p.routeAttribute) {
      const r = text.match(/\[Route\s*\(\s*"([^"]*)"/);
      const cls = text.match(/class\s+(\w+?)Controller\b/)?.[1] ?? '';
      if (r) prefix = r[1].replace(/\[controller\]/i, cls.toLowerCase());
    }
    if (p.controllerDecorator) prefix = text.match(/@Controller\s*\(\s*['"`]([^'"`]*)['"`]/)?.[1] ?? '';
    lines.forEach((l, i) => {
      if (i === prefixLine || COMMENT_LINE.test(l)) return;
      const m = l.match(p.re);
      if (m) out.push({ method: p.method(m), path: join(prefix, p.path(m)), line: i + 1, framework: p.framework });
    });
  }
  return out.sort((a, b) => a.line - b.line);
}

const VERB = '(SELECT|INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|REPLACE\\s+INTO)';
const IN_LINE = new RegExp(`(["'])\\s*\\(?\\s*(${VERB}\\b(?:\\\\.|(?!\\1)[^\\n\\\\])*)\\1`, 'gi');
const IN_BLOCK = new RegExp('(`|"""|\'\'\')\\s*\\(?\\s*(' + VERB + '\\b[\\s\\S]{0,4000}?)\\1', 'gi');
const IN_MAPPER = /<(select|insert|update|delete)\b[^>]*>([\s\S]*?)<\/\1>/gi;

/**
 * True when text reads as a SQL statement and not as prose ("Select a file from the list", "Delete from cart").
 * The verb must be all upper or all lower case; a lower-case statement needs one more SQL sign; a SELECT needs a
 * select list that looks like one (a star, a comma, a dot, a call, a keyword, or a single name) before FROM.
 */
export function looksLikeSql(text) {
  const t = text.trim().replace(/^\(\s*/, '');
  const verb = t.match(/^[A-Za-z]+/)?.[0] ?? '';
  const upper = verb === verb.toUpperCase();
  if (!upper && verb !== verb.toLowerCase()) return false;
  if (!upper && !/\b(where|values|set|join)\b|[*=?;]/i.test(t.slice(verb.length))) return false;
  if (/^select\b/i.test(t)) {
    const m = t.match(/^select\s+([\s\S]+?)\s+from\s+[\w`"[.{$:#]/i);
    if (!m) return false;
    const list = m[1].trim();
    return /[*,.(]|\b(as|distinct|count|sum|min|max|avg|top|case)\b/i.test(list) || !/\s/.test(list);
  }
  if (/^update\b/i.test(t)) return /^update\s+[\w`".[\]]+\s+set\s/i.test(t);
  return /^(insert\s+into|replace\s+into|delete\s+from)\s+[\w`"[.{$:#]/i.test(t);
}

/** SQL statements in a file: [{ text, line }], whitespace collapsed, in source order. */
export function sqlStatements(text, ext) {
  const found = new Map(); // offset -> text
  const add = (start, sql) => {
    const offset = start + (sql.length - sql.trimStart().length); // the line of the statement's first word
    const clean = sql.replace(/\s+/g, ' ').trim();
    if (looksLikeSql(clean) && !found.has(offset)) found.set(offset, clean);
  };
  for (const m of text.matchAll(IN_BLOCK)) add(m.index + m[0].indexOf(m[2]), m[2]);
  for (const m of text.matchAll(IN_LINE)) add(m.index + m[0].indexOf(m[2]), m[2]);
  if (ext === '.xml') for (const m of text.matchAll(IN_MAPPER)) add(m.index + m[0].indexOf(m[2]), m[2].replace(/<[^>]+>/g, (tag) => ' '.repeat(tag.length)));
  const lineOf = (offset) => text.slice(0, offset).split('\n').length;
  const out = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([offset, sql]) => ({ text: sql, line: lineOf(offset) }));
  // a statement inside a block literal is also seen by the one-line rule when it fits on its line: keep one per line
  return out.filter((s, i) => i === 0 || s.line !== out[i - 1].line || s.text !== out[i - 1].text);
}

/** URLs in a file: [{ url, line, context }]. */
export function urlFacts(text) {
  const out = [];
  text.split(/\r?\n/).forEach((l, i) => {
    if (URL_NOISE.test(l) || COMMENT_LINE.test(l)) return;
    for (const m of l.matchAll(/https?:\/\/[^\s"'<>)\\`]+/g)) {
      const url = m[0].replace(/[.,;]+$/, '');
      try {
        if (!new URL(url).hostname.includes('.') && new URL(url).hostname !== 'localhost') continue; // "http://" + variable
      } catch {
        continue;
      }
      out.push({ url, line: i + 1, context: ASSET_URL.test(url) || ASSET_LINE.test(l) ? 'asset' : 'code' });
    }
  });
  return out;
}

/** Scan a source tree. `exclude` = folders (relative) to leave out, as in target.yaml source.scan_exclude. */
export function extract(sourceDir, { exclude = [] } = {}) {
  const skip = exclude.map((e) => e.replace(/^\/+|\/+$/g, ''));
  const files = [];
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(sourceDir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.some((x) => r === x || r.startsWith(`${x}/`))) continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(r);
        continue;
      }
      const ext = path.extname(e.name).toLowerCase();
      if (!LANGUAGE[ext] || SKIP_FILES.test(r)) continue;
      const full = path.join(sourceDir, r);
      if (fs.statSync(full).size > MAX_BYTES) continue;
      const text = fs.readFileSync(full, 'utf8');
      const doc = ['.json', '.yml', '.yaml', '.toml', '.ini', '.properties'].includes(ext);
      files.push({
        path: r,
        language: LANGUAGE[ext],
        lines: text.split(/\r?\n/).length,
        parse_error: null,
        includes: [], session: [], superglobals: [], uploads: [], calls: [], functions: [], redirects: [], js_redirects: [], forms: [], fields_outside_forms: [],
        sql: doc ? [] : sqlStatements(text, ext),
        urls: urlFacts(text),
        routes: routeHints(text, ext),
        top_level_html_bytes: 0,
      });
    }
  };
  walk('');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { pack: 'generic', pack_version: VERSION, language_version: null, pages: 'none', files };
}
