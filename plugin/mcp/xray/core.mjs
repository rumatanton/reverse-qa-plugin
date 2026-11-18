// Xray Cloud client and the tool logic behind the reverse-qa Xray MCP server and the publish-xray skill.
// Writes are two-step on purpose: a dry run returns a preview_id (a hash of the exact payload), and the real import
// refuses any payload whose hash differs. So nothing reaches Jira that a person has not seen first.
import { validateBulkTests, previewId } from '../../lib/xray.mjs';

export const DEFAULT_BASE_URL = 'https://xray.cloud.getxray.app/api/v2';

/** Settings from the environment (the plugin passes its userConfig values in as env vars). Never returns secrets. */
export function configFromEnv(env = process.env) {
  const blank = (v) => (v && !/^\$\{.*\}$/.test(v) ? v : ''); // an unset ${user_config.x} can arrive literally
  return {
    baseUrl: blank(env.XRAY_BASE_URL) || DEFAULT_BASE_URL,
    clientId: blank(env.XRAY_CLIENT_ID),
    clientSecret: blank(env.XRAY_CLIENT_SECRET),
    projectKey: blank(env.XRAY_PROJECT_KEY),
  };
}

export function describeConfig(cfg) {
  return { base_url: cfg.baseUrl, project_key: cfg.projectKey || null, credentials: Boolean(cfg.clientId && cfg.clientSecret), mode: cfg.clientId && cfg.clientSecret ? 'online' : 'offline (validate and dry-run only)' };
}

export class XrayClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, clientId, clientSecret, fetchImpl = fetch, pollMs = 1500, timeoutMs = 300_000 } = {}) {
    Object.assign(this, { baseUrl: baseUrl.replace(/\/+$/, ''), clientId, clientSecret, fetchImpl, pollMs, timeoutMs, token: null });
  }

  async request(path, { method = 'GET', body, contentType = 'application/json', auth = true } = {}) {
    if (auth && !this.token) await this.authenticate();
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': contentType } : {}), ...(auth ? { authorization: `Bearer ${this.token}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (!res.ok) throw new Error(`Xray ${method} ${path} failed: HTTP ${res.status} ${typeof data === 'string' ? data.slice(0, 300) : JSON.stringify(data).slice(0, 300)}`);
    return data;
  }

  async authenticate() {
    if (!this.clientId || !this.clientSecret) throw new Error('Xray credentials are not configured (XRAY_CLIENT_ID / XRAY_CLIENT_SECRET)');
    const token = await this.request('/authenticate', { method: 'POST', body: { client_id: this.clientId, client_secret: this.clientSecret }, auth: false });
    this.token = String(token).replace(/^"|"$/g, '');
    return this.token;
  }

  async importTests(tests) {
    const { jobId } = await this.request('/import/test/bulk', { method: 'POST', body: tests });
    if (!jobId) throw new Error('Xray did not return a jobId for the bulk import');
    return jobId;
  }

  async waitForJob(jobId) {
    const start = Date.now();
    for (;;) {
      const s = await this.request(`/import/test/bulk/${encodeURIComponent(jobId)}/status`);
      if (['successful', 'partially_successful', 'failed', 'unsuccessful'].includes(s.status)) return s;
      if (Date.now() - start > this.timeoutMs) throw new Error(`Xray import job ${jobId} still "${s.status}" after ${this.timeoutMs} ms`);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  importExecution(results) {
    return this.request('/import/execution', { method: 'POST', body: results });
  }

  importJunit(xml, { projectKey, testPlanKey, testExecKey } = {}) {
    const q = new URLSearchParams(Object.entries({ projectKey, testPlanKey, testExecKey }).filter(([, v]) => v));
    return this.request(`/import/execution/junit?${q}`, { method: 'POST', body: xml, contentType: 'text/xml' });
  }

  async findTests(jql, limit = 100) {
    const query = `query($jql: String, $limit: Int!) { getTests(jql: $jql, limit: $limit) { total results { issueId jira(fields: ["key", "summary"]) testType { name } } } }`;
    const data = await this.request('/graphql', { method: 'POST', body: { query, variables: { jql, limit } } });
    if (data.errors?.length) throw new Error(`Xray GraphQL: ${data.errors.map((e) => e.message).join('; ')}`);
    const r = data.data?.getTests ?? { total: 0, results: [] };
    return { total: r.total, tests: r.results.map((t) => ({ issueId: t.issueId, key: t.jira?.key, summary: t.jira?.summary, type: t.testType?.name })) };
  }
}

// ---- tool logic (shared by the MCP server and the publish-xray CLI) ---------------------------------------------

export function previewTests(tests) {
  const problems = validateBulkTests(tests);
  const byType = {};
  for (const t of Array.isArray(tests) ? tests : []) byType[t.testtype] = (byType[t.testtype] ?? 0) + 1;
  const linked = Array.isArray(tests) ? tests.filter((t) => t.update?.issuelinks?.length).length : 0;
  return { preview_id: previewId(tests), tests: Array.isArray(tests) ? tests.length : 0, by_type: byType, linked_to_requirements: linked, problems, ready: problems.length === 0 };
}

/** Real import: only the payload the preview showed, only when it is valid. Returns created keys in input order. */
export async function publishTests(client, tests, expectedPreviewId) {
  const p = previewTests(tests);
  if (!p.ready) throw new Error(`refusing to import: ${p.problems.length} problem(s): ${p.problems.slice(0, 5).join('; ')}`);
  if (p.preview_id !== expectedPreviewId) throw new Error(`refusing to import: preview_id ${expectedPreviewId} does not match this payload (${p.preview_id}); run the dry run again and confirm what it shows`);
  const jobId = await client.importTests(tests);
  const status = await client.waitForJob(jobId);
  const issues = status.result?.issues ?? [];
  const errors = status.result?.errors ?? [];
  // Xray reports per-element errors by elementNumber (0-based position in the payload); created issues follow the
  // payload order with the failed elements left out.
  const failed = new Set(errors.map((e) => e.elementNumber));
  const keys = [];
  let next = 0;
  for (let i = 0; i < tests.length; i++) keys.push(failed.has(i) ? null : (issues[next++]?.key ?? null));
  return { job_id: jobId, status: status.status, keys, errors };
}

export function previewResults(results) {
  const problems = [];
  if (!results || !Array.isArray(results.tests)) problems.push('results.tests must be a list');
  for (const [i, t] of (results?.tests ?? []).entries()) {
    if (!/^[A-Z][A-Z0-9_]+-\d+$/.test(t.testKey ?? '')) problems.push(`tests[${i}]: testKey must be a Jira key`);
    if (!['PASSED', 'FAILED', 'TODO', 'EXECUTING', 'PASS', 'FAIL'].includes(t.status)) problems.push(`tests[${i}]: unknown status ${t.status}`);
  }
  const counts = {};
  for (const t of results?.tests ?? []) counts[t.status] = (counts[t.status] ?? 0) + 1;
  return { preview_id: previewId(results), tests: results?.tests?.length ?? 0, by_status: counts, problems, ready: problems.length === 0 };
}

export async function publishResults(client, results, expectedPreviewId) {
  const p = previewResults(results);
  if (!p.ready) throw new Error(`refusing to import results: ${p.problems.slice(0, 5).join('; ')}`);
  if (p.preview_id !== expectedPreviewId) throw new Error(`refusing to import results: preview_id ${expectedPreviewId} does not match this payload (${p.preview_id})`);
  const r = await client.importExecution(results);
  return { test_execution: r.key ?? r.testExecIssue?.key ?? null, response: r };
}
