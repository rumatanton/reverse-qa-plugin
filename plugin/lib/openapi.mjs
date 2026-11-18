// Read an OpenAPI 3 or Swagger 2 spec (YAML or JSON) into endpoints for the inventory: one per path, with its
// methods, parameters, security requirements and the spec line each fact sits on. No network, no code generation.
import YAML, { LineCounter } from 'yaml';

const METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'];
const strip = (p) => String(p ?? '').replace(/^\/+|\/+$/g, '');

function resolve(doc, node, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 5) return node ?? {};
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    const target = node.$ref.slice(2).split('/').reduce((o, k) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
    return resolve(doc, target, depth + 1);
  }
  return node;
}

const exampleOf = (doc, p) => {
  const schema = resolve(doc, p.schema);
  return p.example ?? p['x-example'] ?? schema.example ?? schema.default ?? schema.enum?.[0];
};

/** The URL path prefix the spec declares for its server ('' when none): servers[0].url or basePath. */
export function specBasePath(doc) {
  if (doc.basePath) return strip(doc.basePath);
  const url = doc.servers?.[0]?.url;
  if (!url) return '';
  try {
    return strip(new URL(url, 'http://spec.local').pathname);
  } catch {
    return '';
  }
}

/**
 * Endpoints of a spec.
 *   text      the spec (YAML or JSON)
 *   file      the name to cite (relative to the source root, or the saved copy)
 *   baseUrl   the target's runtime.base_url: a server prefix already inside it is not added twice
 * Returns { title, version, endpoints, problems }. Each endpoint: { path (relative to baseUrl, path parameters as
 * {name}), methods, params: { PATH, QUERY, HEADER, BODY }, guards: [{ key, file, line }], operations, evidence,
 * example_path (when every path parameter has an example in the spec), example_query (required query parameters
 * that have one), source: 'openapi' }.
 */
export function endpointsFromSpec(text, { file = 'openapi', baseUrl = null } = {}) {
  const lineCounter = new LineCounter();
  const parsed = YAML.parseDocument(text, { lineCounter });
  const problems = parsed.errors.map((e) => e.message.split('\n')[0]);
  const doc = parsed.toJS() ?? {};
  if (!doc.openapi && !doc.swagger) problems.push('not an OpenAPI or Swagger document (no "openapi" or "swagger" field)');
  if (!doc.paths || typeof doc.paths !== 'object') return { title: doc.info?.title ?? null, version: doc.info?.version ?? null, endpoints: [], problems: [...problems, 'the spec has no paths'] };
  const lineOf = (keys) => {
    const pair = keys.reduce((node, k, i) => {
      const item = node?.items?.find((x) => String(x.key?.value ?? x.key) === String(k));
      return i === keys.length - 1 ? item?.key : item?.value;
    }, parsed.contents);
    return pair?.range ? lineCounter.linePos(pair.range[0]).line : 1;
  };
  let prefix = specBasePath(doc);
  if (prefix && baseUrl) {
    const base = strip(new URL(baseUrl).pathname);
    if (base === prefix || base.endsWith(`/${prefix}`)) prefix = '';
  }
  const globalSecurity = doc.security ?? [];
  const endpoints = [];
  for (const [rawPath, itemRaw] of Object.entries(doc.paths)) {
    const item = resolve(doc, itemRaw);
    const ops = METHODS.filter((m) => item?.[m]);
    if (!ops.length) continue;
    const params = { PATH: [], QUERY: [], HEADER: [], BODY: [] };
    const examples = { path: {}, query: {} };
    const guards = [];
    const operations = [];
    const add = (list, v) => { if (v && !list.includes(v)) list.push(v); };
    for (const m of ops) {
      const op = item[m];
      for (const pRaw of [...(item.parameters ?? []), ...(op.parameters ?? [])]) {
        const p = resolve(doc, pRaw);
        const where = { path: 'PATH', query: 'QUERY', header: 'HEADER', formData: 'BODY' }[p.in];
        if (where) add(params[where], p.name);
        if (p.in === 'body') for (const k of Object.keys(resolve(doc, p.schema).properties ?? {})) add(params.BODY, k);
        const ex = exampleOf(doc, p);
        if (ex !== undefined && p.in === 'path') examples.path[p.name] = ex;
        if (ex !== undefined && p.in === 'query' && p.required) examples.query[p.name] = ex;
      }
      for (const media of Object.values(resolve(doc, op.requestBody).content ?? {})) for (const k of Object.keys(resolve(doc, media.schema).properties ?? {})) add(params.BODY, k);
      const security = op.security ?? globalSecurity;
      const line = lineOf(['paths', rawPath, m]);
      for (const req of security) for (const scheme of Object.keys(req)) if (!guards.some((g) => g.key === scheme)) guards.push({ key: scheme, file, line });
      operations.push({ method: m.toUpperCase(), operation_id: op.operationId ?? null, summary: op.summary ?? null, line, secured: security.some((r) => Object.keys(r).length > 0), responses: Object.keys(op.responses ?? {}).sort() });
    }
    const names = [...rawPath.matchAll(/\{([^}]+)\}/g)].map((x) => x[1]);
    for (const n of names) add(params.PATH, n);
    const rel = strip([prefix, strip(rawPath)].filter(Boolean).join('/'));
    const endpoint = { path: rel, methods: ops.map((m) => m.toUpperCase()), params: Object.fromEntries(Object.entries(params).filter(([, v]) => v.length)), guards, operations, evidence: `${file}:${lineOf(['paths', rawPath])}`, source: 'openapi' };
    if (names.length && names.every((n) => examples.path[n] !== undefined)) endpoint.example_path = rel.replace(/\{([^}]+)\}/g, (_, n) => encodeURIComponent(String(examples.path[n])));
    if (Object.keys(examples.query).length) endpoint.example_query = new URLSearchParams(Object.entries(examples.query).map(([k, v]) => [k, String(v)])).toString();
    endpoints.push(endpoint);
  }
  endpoints.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { title: doc.info?.title ?? null, version: doc.info?.version ?? null, endpoints, problems };
}
