// The framework's test object. Import { test, expect } from here, never from @playwright/test directly.
// Fixtures:
//   outboundGuard (auto)  every request to a stubbed integration or a never_test host is blocked and recorded;
//                         tests can install their own handler with gateway.handle() (the payment stub)
//   serverLogWatch (auto) new server log lines during the test are attached; a new server error fails the test
//                         (only when target.yaml names a server log the plugin can read)
//   xrayLinks     (auto)  @TC- tags become test_key / requirements annotations for the Xray JUnit reporter
//   db                    counts, rows and SQL through the db container (plugin lib/db.mjs); needs target.yaml database
//   snapshot              db-snapshot take/diff, with labels scoped to the test; needs target.yaml database
//   roleRequest(role)     an API request context logged in as a role, on its own session (a cookie or a token)
//   rolePage(role)        a browser page logged in as a role on its own session, guarded the same way. For a desktop
//                         app (support/desktop.ts) it is a window of the app itself: each call starts its own copy
//                         of the app, logged in through the app's login screen
import fs from 'node:fs';
import path from 'node:path';
import { test as base, expect, request, type APIRequestContext, type BrowserContext, type Page, type Route } from '@playwright/test';
import { target, baseURL, appService, OUTPUT, logIn, tokenHeaders, usesToken, blockedHosts, isWeb, isDesktop, hasDatabase, hasServerLog } from './target.ts';
import { dbLib, runtimeLib, snapshotLib, YAML } from './plugin.ts';
import { launchApp, closeApp, uiLogIn, type RunningApp } from './desktop.ts';

type Handler = (route: Route) => Promise<void> | void;
type Gateway = { blocked: string[]; handle: (fn: Handler) => void; handler: () => Handler | null };
type Db = { count: (table: string) => number; counts: () => Record<string, number>; rows: (table: string) => any[]; exec: (sql: string) => string };
type Snap = { take: (label: string) => any; diff: (before: string, after: string) => any };
type Fixtures = { gateway: Gateway; db: Db; snapshot: Snap; roleRequest: (role: string) => Promise<APIRequestContext>; rolePage: (role: string) => Promise<Page>; serverLogWatch: void; xrayLinks: void };

/**
 * Block (and record) every request to a stubbed integration or never_test host in a browser context. A blocked page
 * navigation (a form auto-submitted to the payment gateway) answers 204 No Content, so the browser stays on the app's
 * page instead of showing its own error page; open pages with openPage() (pages/base.page.ts), which copes with that.
 */
async function guard(context: BrowserContext, blocked: string[], handler: () => ((route: Route) => Promise<void> | void) | null) {
  for (const host of blockedHosts()) {
    await context.route(new RegExp(`^https?://${host.replace(/\./g, '\\.')}(:\\d+)?/`), async (route) => {
      blocked.push(route.request().url());
      const h = handler();
      if (h) await h(route);
      else if (route.request().isNavigationRequest()) await route.fulfill({ status: 204 });
      else await route.abort('blockedbyclient');
    });
  }
}

const readJson = (rel: string) => (fs.existsSync(path.join(OUTPUT, rel)) ? JSON.parse(fs.readFileSync(path.join(OUTPUT, rel), 'utf8')) : {});
const readYaml = (rel: string) => (fs.existsSync(path.join(OUTPUT, rel)) ? YAML.parse(fs.readFileSync(path.join(OUTPUT, rel), 'utf8')) ?? {} : {});
let links: { testKeys: Record<string, string>; caseReqs: Record<string, string[]>; jiraKeys: Record<string, string> } | null = null;
function xrayData() {
  if (!links) {
    const cases = readYaml('test-cases/cases.yaml').cases ?? [];
    links = { testKeys: readJson('xray/xray-keys.json'), jiraKeys: readYaml('jira-keys.yaml'), caseReqs: Object.fromEntries(cases.map((c: any) => [c.id, [c.requirement].flat()])) };
  }
  return links;
}

export const test = base.extend<Fixtures>({
  gateway: [
    isDesktop
      ? async ({}, use) => {
          // a desktop app has no browser context to guard up front: rolePage guards each copy of the app it starts
          const blocked: string[] = [];
          let handler: ((route: Route) => Promise<void> | void) | null = null;
          await use({ blocked, handle: (fn) => (handler = fn), handler: () => handler });
        }
      : async ({ context }, use) => {
          const blocked: string[] = [];
          let handler: ((route: Route) => Promise<void> | void) | null = null;
          await guard(context, blocked, () => handler);
          await use({ blocked, handle: (fn) => (handler = fn), handler: () => handler });
        },
    { auto: isWeb }, // a browser guard: an API target has no browser, and its tests only call the base URL
  ],

  serverLogWatch: [
    async ({}, use, testInfo) => {
      if (!hasServerLog) return use(); // no server log configured, or the app's containers are not ours to read
      const before = runtimeLib.serverLog(target, appService).length;
      await use();
      const added = runtimeLib.serverLog(target, appService).slice(before);
      if (!added.trim()) return;
      await testInfo.attach('server-log', { body: added, contentType: 'text/plain' });
      const c = runtimeLib.classifyServerLog(added, runtimeLib.logPatterns(target.def));
      // a documented defect allows only its own error: annotation { type: 'allow-server-error', description: '<file>:<line> <finding>' }
      // ('allow-php-fatal' is the older name of the same annotation)
      const allowed = testInfo.annotations.filter((a) => a.type === 'allow-server-error' || a.type === 'allow-php-fatal').map((a) => (a.description ?? '').split(' ')[0]);
      const unexpected = c.fatal.filter((l) => !allowed.some((loc) => loc && l.includes(loc)));
      // an observation step (crawl-app) is not a test of the app: it records the server errors per page itself
      if (testInfo.annotations.some((a) => a.type === 'server-errors-recorded')) return;
      if (unexpected.length) throw new Error(`${runtimeLib.serverErrorLabel(target.def)} during the test:\n${unexpected.join('\n')}`);
    },
    { auto: true },
  ],

  xrayLinks: [
    async ({}, use, testInfo) => {
      const ids = [...new Set(`${testInfo.title} ${testInfo.tags.join(' ')}`.match(/TC-[A-Z]+-\d{3}/g) ?? [])];
      const d = xrayData();
      for (const id of ids) {
        if (d.testKeys[id]) testInfo.annotations.push({ type: 'test_key', description: d.testKeys[id] });
        const reqs = (d.caseReqs[id] ?? []).map((r) => d.jiraKeys[r]).filter(Boolean);
        if (reqs.length) testInfo.annotations.push({ type: 'requirements', description: reqs.join(',') });
      }
      await use();
    },
    { auto: true },
  ],

  db: async ({}, use) => {
    if (!hasDatabase) throw new Error('this test reads the database, and target.yaml names no database the plugin can reach (database: and runtime.compose_file): data checks do not apply to this target');
    await use({
      count: (t) => dbLib.counts(target, [t])[t],
      counts: () => dbLib.counts(target),
      rows: (t) => dbLib.rows(target, t, dbLib.schema(target)[t]),
      exec: (sql) => dbLib.execSql(target, sql),
    });
  },

  snapshot: async ({}, use, testInfo) => {
    if (!hasDatabase) throw new Error('this test takes database snapshots, and target.yaml names no database the plugin can reach: data checks do not apply to this target');
    const scope = `t${testInfo.testId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12)}`;
    const dir = path.join(OUTPUT, 'snapshots');
    await use({
      take: (label) => snapshotLib.takeSnapshot(target, `${scope}-${label}`),
      diff: (a, b) => {
        const d = snapshotLib.compare(target, `${scope}-${a}`, `${scope}-${b}`);
        testInfo.attach('db-diff', { body: JSON.stringify(d, null, 2), contentType: 'application/json' }); // kept in the run archive
        return d;
      },
    });
    // a test's snapshots are evidence for that run only: attached above, then removed from output/snapshots/
    if (fs.existsSync(dir)) for (const f of fs.readdirSync(dir)) if (f.startsWith(`${scope}-`)) fs.rmSync(path.join(dir, f));
  },

  roleRequest: async ({}, use, testInfo) => {
    const made: APIRequestContext[] = [];
    await use(async (role) => {
      if (role !== 'Visitor' && usesToken(role)) {
        // a token login: log in with a throwaway context, then send the token in a header on every request
        const login = await request.newContext({ baseURL });
        made.push(login);
        const withToken = await request.newContext({ baseURL, extraHTTPHeaders: await tokenHeaders(login, role) });
        made.push(withToken);
        return withToken;
      }
      const ctx = await request.newContext({ baseURL });
      made.push(ctx);
      if (role !== 'Visitor') await logIn(ctx, role); // its own session: a logout elsewhere cannot end it
      return ctx;
    });
    for (const c of made) await c.dispose();
  },

  /**
   * A browser page logged in as a role, with the same outbound guard. Pages open only when asked for: depending on the
   * built-in `page` fixture would open a blank window for every test, skipped ones included.
   */
  rolePage: isDesktop
    ? async ({ gateway }, use, testInfo) => {
        // a desktop app: every call starts its own copy of the app with its own data folder, so its session and its
        // data are its own; a failed test keeps a screenshot of each window and the trace of its steps
        const made: RunningApp[] = [];
        const crashes: string[] = [];
        await use(async (role) => {
          const running = await launchApp();
          made.push(running);
          // a desktop app has no server log to watch: an error nothing caught in one of its windows is its "server error"
          running.app.context().on('weberror', (e) => crashes.push(String(e.error()?.message ?? e.error())));
          await guard(running.app.context(), gateway.blocked, gateway.handler);
          if (role !== 'Visitor') await uiLogIn(running.page, role); // through the app's own login screen
          return running.page;
        });
        // a documented defect allows only its own error: annotation { type: 'allow-page-error', description: '<text in the message> <finding>' }
        const allowed = testInfo.annotations.filter((a) => a.type === 'allow-page-error').map((a) => (a.description ?? '').split(' ')[0]);
        const unexpected = crashes.filter((m) => !allowed.some((text) => text && m.includes(text)));
        if (unexpected.length && testInfo.status === testInfo.expectedStatus) testInfo.status = 'failed'; // so the evidence below is kept
        for (const [n, r] of made.entries()) await closeApp(r, testInfo, n);
        if (unexpected.length) throw new Error(`an error nothing caught in the app's window during the test:\n${unexpected.join('\n')}`);
      }
    : async ({ browser, context, gateway }, use, testInfo) => {
        const made: BrowserContext[] = [];
        await use(async (role) => {
          if (role === 'Visitor') return context.newPage(); // the default context, already guarded by `gateway`
          // a header set on a browser context goes with every request, to other hosts too: not done until it has its own design
          if (usesToken(role)) throw new Error(`role ${role} logs in with a token: a browser session for a token login is not supported yet (use roleRequest)`);
          const ctx = await browser.newContext({ ...testInfo.project.use, baseURL });
          made.push(ctx);
          await guard(ctx, gateway.blocked, gateway.handler); // the test's gateway.handle() applies to role pages too
          await logIn(ctx.request, role); // its own session, shared with the page through the context's cookies
          return ctx.newPage();
        });
        for (const c of made) await c.close();
      },
});

export { expect };
