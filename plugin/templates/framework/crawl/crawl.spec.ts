// crawl-app: walk the running app as every role and record what each one can reach (project "crawl"). The rules live
// in the plugin (lib/crawl.mjs, unit-tested there): GET navigation only, never a form submit or a button click, never
// outside the app's base URL, and no link whose address or label looks destructive or ends the session. This file
// only does the browsing, with the framework's own logins (rolePage) and outbound guard.
// Output: output/scan/crawl.json (scan-repo merges it into the inventory) and output/scan/observed-matrix.csv (what
// each role got on each page, and whether the server logged an error while it asked: an observation for the
// analysts, not an expectation).
import fs from 'node:fs';
import path from 'node:path';
import { request as playwrightRequest, type Page } from '@playwright/test';
import { test, expect } from '../support/fixtures.ts';
import { target, baseURL, OUTPUT, accounts, loginPaths, logIn, usesToken, withServerFatals, isDesktop } from '../support/target.ts';
import { crawlLib, csvLib } from '../support/plugin.ts';

const cfg = target.def.crawl ?? {};
const roles: string[] = ['Visitor', ...accounts().map((a) => a.role)];
const maxPages = Number(process.env.RQA_CRAWL_MAX ?? cfg.max_pages ?? 200);

/**
 * Open one URL and return what the lib records: where it landed, the status, the links and the forms. A link is an
 * <a href> or <area href>, or the address a click handler navigates to (onclick="location.replace('…')"): many apps
 * build their menus that way. The handler's code is read, never run.
 */
async function look(page: Page, url: string) {
  // A desktop app guards its pages in the page's own script (it replaces the address while the page loads), so the
  // wait there ends when the page is committed and the window has stopped moving on, not at the first DOM event,
  // which a redirect in mid-load would interrupt.
  const res = await page.goto(url, { waitUntil: isDesktop ? 'commit' : 'domcontentloaded', timeout: 20_000 }).catch(() => null);
  await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {}); // a page that hands off elsewhere may never finish loading
  if (isDesktop) {
    for (let at = '', n = 0; at !== page.url() && n < 10; n += 1) {
      at = page.url();
      await page.waitForTimeout(200);
      await page.waitForLoadState('load', { timeout: 5_000 }).catch(() => {});
    }
  }
  const seen = await page
    .evaluate(() => {
      const text = (el: any): string => (el.innerText || el.getAttribute('aria-label') || el.title || '').trim();
      return {
        title: document.title,
        links: Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href], area[href]')).map((a) => ({ href: a.href, label: text(a) })),
        clicks: Array.from(document.querySelectorAll('[onclick]')).map((el) => ({ code: el.getAttribute('onclick') ?? '', label: text(el) })),
        forms: Array.from(document.forms).map((f) => ({
          action: f.action,
          method: f.method,
          fields: Array.from(f.elements).map((el: any) => ({ name: el.name, type: el.type || el.tagName.toLowerCase(), required: Boolean(el.required), maxlength: el.maxLength > 0 ? el.maxLength : null })),
        })),
      };
    })
    .catch(() => ({ title: null, links: [], clicks: [], forms: [] }));
  const finalUrl = page.url();
  const fromClicks = seen.clicks.flatMap((c) => crawlLib.scriptTargets(c.code).map((t: string) => ({ href: new URL(t, finalUrl).href, label: c.label })));
  return { requested: url, finalUrl, status: res?.status() ?? 0, title: seen.title, links: [...seen.links, ...fromClicks], forms: seen.forms };
}

/** Where the login sends a role: its own home page, which is where its menu is. Null for a visitor or a token login. */
async function landingOf(role: string): Promise<string | null> {
  if (role === 'Visitor' || usesToken(role)) return null;
  const api = await playwrightRequest.newContext({ baseURL });
  try {
    return await logIn(api, role);
  } finally {
    await api.dispose();
  }
}

test('crawl the app as every role and record what each can reach @crawl', async ({ rolePage }) => {
  test.setTimeout(roles.length * maxPages * 30_000 + 120_000);
  // the crawl observes; it does not judge. Server errors the app logs are recorded per page and role below, so the
  // log watcher must not fail the crawl for them.
  test.info().annotations.push({ type: 'server-errors-recorded', description: 'crawl-app records them in output/scan/crawl.json' });
  const visit = async (page: Page, url: string) => {
    const { result, fatals } = await withServerFatals(() => look(page, url));
    return { ...result, serverErrors: fatals };
  };
  // a desktop app starts at its start page; the base itself is a folder on disk, never a page to open
  const start = cfg.start ?? [isDesktop ? path.basename(target.def.runtime.app.start_page) : target.def.runtime?.health_path ?? ''];
  const crawl = crawlLib.newCrawl({ baseUrl: baseURL, start, skip: cfg.skip ?? [], maxPages, roles });
  crawl.started = new Date().toISOString();
  const opts = { loginPaths: loginPaths() };
  const pages: Record<string, Page> = {};

  // 1. each role follows links from the start pages and from the page its login lands on
  for (const role of roles) {
    pages[role] = await rolePage(role);
    // a desktop app's window is already on the page its login screen moved the role to
    const landing = isDesktop ? (role === 'Visitor' ? null : pages[role].url()) : await landingOf(role);
    const queue: string[] = [...crawl.start.map((p: string) => new URL(p, baseURL).href), ...(landing && crawlLib.relPath(landing, baseURL) !== null ? [landing] : [])];
    const visited = new Set<string>();
    while (queue.length && visited.size < maxPages) {
      const url = queue.shift()!;
      const key = crawlLib.pageKey(url, baseURL);
      if (key === null || visited.has(key)) continue;
      visited.add(key);
      for (const next of crawlLib.recordVisit(crawl, role, await visit(pages[role], url), opts)) queue.push(next.url);
    }
    if (queue.length) crawl.truncated = true;
  }

  // 2. every role asks for every page any role found, so the record says what each role gets on each page
  for (const role of roles) {
    for (const p of Object.values<any>(crawl.pages)) {
      if (p.roles[role]) continue;
      const url = new URL(p.example_query ? `${p.path}?${p.example_query}` : p.path, baseURL).href;
      crawlLib.recordVisit(crawl, role, await visit(pages[role], url), opts);
    }
  }

  const dir = path.join(OUTPUT, 'scan');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'crawl.json'), `${JSON.stringify(crawl, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'observed-matrix.csv'), csvLib.toCsv(crawlLib.observedMatrix(crawl), ['page', 'role', 'observed', 'status', 'landed_on', 'server_errors']));
  expect(Object.keys(crawl.pages).length, 'the crawl reached at least its start page').toBeGreaterThan(0);
});
