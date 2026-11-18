// Which app this framework tests. Everything comes from targets/<name>/target.yaml (loaded with the plugin's loader)
// and from the recon outputs in targets/<name>/output, so nothing app-specific is hard-coded in the framework.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { FRAMEWORK, TARGET_DIR, ROOT, targetLib, csvLib, runtimeLib, platformLib } from './plugin.ts';

export { FRAMEWORK, TARGET_DIR, ROOT };
export const OUTPUT = path.join(TARGET_DIR, 'output');
export const AUTH_DIR = path.join(FRAMEWORK, '.auth');

export const target = targetLib.loadTarget(ROOT, path.basename(TARGET_DIR));
export const runtime = target.def.runtime ?? {};

/**
 * What applies to this target (plugin lib/platform.mjs): the kind of app, and whether the plugin can reach its
 * containers, its database and a server log. Fixtures and specs ask here, so a target without a database or a log
 * gets no data checks and no log watcher, instead of failing somewhere inside them.
 */
export const caps = platformLib.capabilities(target.def);
export const isWeb = caps.kind === 'web';
/** A desktop app driven through its own windows (Electron): pages come from the app itself, never from a browser. */
export const isDesktop = caps.driver === 'electron';
export const hasContainers = caps.runtime === 'compose';
export const hasDatabase = caps.database && hasContainers;
export const hasServerLog = caps.server_log && hasContainers && process.env.RQA_LOG_WATCH !== '0' && process.env.RQA_PHP_WATCH !== '0';

/** RQA_UPGRADE=1 runs the same suite against the second version (e.g. PHP 8) for run-upgrade-compare. */
export const upgrade = process.env.RQA_UPGRADE === '1';
// A desktop app has no server. Its screens are the pages its windows load, so the base of every screen address is
// the folder of the page the app opens first (runtime.app.start_page, relative to the source), unless the app serves
// its pages from an address of its own (then runtime.base_url says which).
const appBase = (): string | undefined => (isDesktop && runtime.app?.start_page ? pathToFileURL(path.join(target.sourceDir, path.dirname(runtime.app.start_page)) + path.sep).href : undefined);
export const baseURL: string = process.env.BASE_URL ?? (upgrade ? runtime.upgrade_base_url : runtime.base_url) ?? appBase();
export const appService: string = (upgrade ? runtime.services?.app_upgrade : runtime.services?.app) ?? 'web';
if (!baseURL) throw new Error(isDesktop ? 'target.yaml has no runtime.app.start_page: tests need the page the app opens first' : 'target.yaml has no runtime.base_url: tests need the URL of the running app');
runtimeLib.assertSafeUrls(target.def, [baseURL]);

export function outputJson<T = any>(rel: string): T | null {
  const file = path.join(OUTPUT, rel);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

export function outputCsv(rel: string): Record<string, string>[] | null {
  const file = path.join(OUTPUT, rel);
  return fs.existsSync(file) ? csvLib.parseCsv(fs.readFileSync(file, 'utf8')) : null;
}

/**
 * How a role logs in (target.yaml test_accounts.<name>.login). Two ways:
 *   form   { path, user_field, password_field, extra }: the app's login form; success is a redirect; the session is a cookie
 *   token  { path, json: { email: "{user}", password: "{password}" }, token: "token", header: "Authorization", scheme: "Bearer" }:
 *          a JSON login; the answer carries a token (a dot path into the body) that later requests send in a header
 */
export type Login = { path: string; user_field?: string; password_field?: string; extra?: Record<string, string>; json?: Record<string, string>; token?: string; header?: string; scheme?: string };
export type Account = { key: string; role: string; user: string; password: string; login: Login };

/** Test accounts that can log in: target.yaml test_accounts with a role, a login and credentials in .env. */
export function accounts(): Account[] {
  const out: Account[] = [];
  for (const [key, a] of Object.entries<any>(target.def.test_accounts ?? {})) {
    const user = process.env[a.user_env] ?? target.env[a.user_env];
    const password = process.env[a.password_env] ?? target.env[a.password_env];
    if (a.role && a.login?.path && user && password) out.push({ key, role: a.role, user, password, login: a.login });
  }
  return out;
}

/**
 * Run a request and return the server errors the app logged while it ran. A page can crash after it has already sent
 * "200 OK" or a redirect, so the status alone does not show a server error. Without a server log (none configured,
 * or RQA_LOG_WATCH=0) the list is empty.
 */
export async function withServerFatals<T>(during: () => Promise<T>): Promise<{ result: T; fatals: string[] }> {
  if (!hasServerLog) return { result: await during(), fatals: [] };
  const before = runtimeLib.serverLog(target, appService).length;
  const result = await during();
  return { result, fatals: runtimeLib.classifyServerLog(runtimeLib.serverLog(target, appService).slice(before), runtimeLib.logPatterns(target.def)).fatal };
}

export function account(role: string): Account {
  const a = accounts().find((x) => x.role === role);
  if (!a) throw new Error(`no logged-in session for role ${role}: add a test account (login, or register: for a fresh one per run) in target.yaml test_accounts`);
  return a;
}

/** True when the role logs in with a token (a JSON login), not with a form and a session cookie. */
export const usesToken = (role: string): boolean => Boolean(account(role).login.json);

/**
 * The header a role's requests carry after a token login, e.g. { Authorization: 'Bearer …' }. Each call logs in again,
 * so each test has its own token.
 */
export async function tokenHeaders(api: APIRequestContext, role: string): Promise<Record<string, string>> {
  const a = account(role);
  const fill = (v: string) => String(v).replaceAll('{user}', a.user).replaceAll('{password}', a.password);
  const res = await api.post(a.login.path, { data: Object.fromEntries(Object.entries(a.login.json ?? {}).map(([k, v]) => [k, fill(v)])), maxRedirects: 0 });
  if (!res.ok()) throw new Error(`login as ${role} at ${a.login.path} answered HTTP ${res.status()}`);
  const body = await res.json().catch(() => null);
  const token = (a.login.token ?? 'token').split('.').reduce((o: any, k) => o?.[k], body);
  if (typeof token !== 'string' || !token) throw new Error(`login as ${role} at ${a.login.path}: no token at "${a.login.token ?? 'token'}" in the answer`);
  return { [a.login.header ?? 'Authorization']: [a.login.scheme ?? 'Bearer', token].filter(Boolean).join(' ') };
}

/**
 * Log a request context in as a role through the app's own login form (target.yaml test_accounts). Each test logs in
 * on its own server session: one shared session would be ended for every later test by any test that opens a logout
 * page. A browser context logs in through `context.request`, which shares the context's cookies.
 * Returns the full URL the login sends the role to (its own home page, where its menu is), or null.
 */
export async function logIn(api: APIRequestContext, role: string): Promise<string | null> {
  const a = account(role);
  if (a.login.json) throw new Error(`role ${role} logs in with a token: use tokenHeaders(), not logIn()`);
  await api.get(a.login.path);
  const res = await api.post(a.login.path, { form: { [a.login.user_field!]: a.user, [a.login.password_field!]: a.password, ...(a.login.extra ?? {}) }, maxRedirects: 0 });
  if (res.status() < 300 || res.status() >= 400) throw new Error(`login as ${role} at ${a.login.path} did not redirect (HTTP ${res.status()})`);
  const to = res.headers()['location'];
  return to ? new URL(to, new URL(a.login.path, baseURL)).href : null;
}

export type PageParams = { query?: string; path?: Record<string, string | number>; without?: string };

/** target.yaml page_params: the query (and path values) a user arrives with on a detail page, and the finding a bare request reproduces. */
export function pageParams(): Record<string, PageParams> {
  return target.def.page_params ?? {};
}

let inventoryPages: Map<string, any> | null = null;
const inventoryPage = (page: string) => {
  inventoryPages ??= new Map((outputJson('inventory.json')?.pages ?? []).map((p: any) => [p.path, p]));
  return inventoryPages.get(page);
};

/**
 * The URL a page test opens. Values come from target.yaml page_params first (what the person stated), then from the
 * examples an API spec declares (example_path, example_query in the inventory). A query the crawl happened to see
 * (seen_query) is never used: a link can write data. A path parameter with no value stays as {name}: see
 * needsExample().
 */
export function pageUrl(page: string): string {
  const stated = pageParams()[page];
  const known = inventoryPage(page);
  let p = page;
  if (stated?.path) p = page.replace(/\{([^}]+)\}/g, (m, n) => (stated.path![n] !== undefined ? encodeURIComponent(String(stated.path![n])) : m));
  else if (known?.example_path) p = known.example_path;
  const q = stated?.query ?? known?.example_query;
  return q ? `${p}?${q}` : p;
}

/** True when a page's URL still has a path parameter with no value: no test can call it until someone gives one. */
export const needsExample = (page: string): boolean => /\{[^}]+\}/.test(pageUrl(page));

/** Login page paths (relative to the base URL), used to recognise "redirected to log in". */
export function loginPaths(): string[] {
  return Object.values<any>(target.def.test_accounts ?? {}).map((a) => a.login?.path).filter(Boolean);
}

export function storageStateFor(role: string): string | null {
  const file = path.join(AUTH_DIR, `${role}.json`);
  return fs.existsSync(file) ? file : null;
}

/** Hosts tests must never reach: integrations marked test_policy: stub, plus safety.never_test. */
export function blockedHosts(): string[] {
  const stubbed = (target.def.integrations ?? []).filter((i: any) => i.test_policy === 'stub').flatMap((i: any) => i.outbound_hosts ?? []);
  return [...new Set([...stubbed, ...(target.def.safety?.never_test ?? [])])];
}
