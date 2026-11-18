// crawl-app, the part with no browser in it: which links to follow, how visits are recorded per role, and how the
// record becomes inventory endpoints. The framework's crawl spec does the browsing and calls these functions, so the
// rules are tested here without a browser.
//
// Safety rules the crawl keeps:
//   - GET navigation only: it never submits a form and never clicks a button.
//   - It stays inside the app's base URL. Links to other hosts are recorded, never followed.
//   - A link is skipped when its address or its visible label looks destructive or ends the session (SKIP_WORDS, plus
//     target.yaml crawl.skip). An app that changes data on other GET links will still be changed: crawl a disposable
//     copy.

export const SKIP_WORDS = ['logout', 'log out', 'log-out', 'signout', 'sign out', 'sign-out', 'delete', 'remove', 'destroy', 'unsend', 'cancel', 'purge', 'drop', 'reset'];

const strip = (p) => String(p ?? '').replace(/^\/+/, '');
// a link to a download or an asset is recorded as a file, never opened as a page
const FILE_LINK = /\.(pdf|zip|gz|tar|rar|7z|docx?|xlsx?|pptx?|csv|txt|png|jpe?g|gif|svg|webp|ico|bmp|mp3|mp4|avi|mov|webm|css|js|map|woff2?|ttf|eot|exe|msi|dmg|apk)$/i;

/** Path of url relative to the base URL ('' = the base itself), or null when url is outside the app. */
export function relPath(url, baseUrl) {
  let u;
  let b;
  try {
    b = new URL(baseUrl);
    u = new URL(url, b);
  } catch {
    return null;
  }
  // a web app: same origin. A desktop app's pages are files, or served from an address of the app's own (file:, app:):
  // then "inside the app" is the same scheme and host, under the base folder.
  const web = /^https?:$/.test(b.protocol);
  if (web ? !/^https?:$/.test(u.protocol) || u.origin !== b.origin : u.protocol !== b.protocol || u.host !== b.host) return null;
  const basePath = b.pathname.endsWith('/') ? b.pathname : `${b.pathname}/`;
  if (u.pathname === basePath.slice(0, -1)) return '';
  if (!u.pathname.startsWith(basePath)) return null;
  return decodeURI(u.pathname.slice(basePath.length));
}

/** Query parameter names of a URL, sorted. */
export function queryNames(url, baseUrl) {
  try {
    return [...new Set([...new URL(url, baseUrl).searchParams.keys()])].sort();
  } catch {
    return [];
  }
}

/** One page pattern = path + the set of query names, so book.php?id=1 and book.php?id=2 are one page. */
export function pageKey(url, baseUrl) {
  const p = relPath(url, baseUrl);
  if (p === null) return null;
  const names = queryNames(url, baseUrl);
  return names.length ? `${p}?${names.join('&')}` : p;
}

/**
 * The addresses a click handler navigates to, read from its code without running it: location = '…',
 * location.href = '…', location.assign('…'), location.replace('…'), window.open('…'). Many apps build their menus this
 * way instead of with links. Only literal addresses are found; one built from variables is not.
 */
export function scriptTargets(code) {
  const re = /(?:\b(?:window\.|document\.|self\.|top\.|parent\.)?location(?:\.href)?\s*=\s*|\blocation\.(?:assign|replace)\(\s*|\bwindow\.open\(\s*)(['"`])([^'"`]+)\1/g;
  return [...String(code ?? '').matchAll(re)].map((m) => m[2]);
}

/** Why a link must not be followed, or null when it may be. `label` = its visible text, aria-label or title. */
export function skipReason({ href, label = '' }, { baseUrl, skip = [] } = {}) {
  if (!href || /^(#|javascript:|mailto:|tel:|data:|blob:)/i.test(href.trim())) return 'not a page link';
  if (relPath(href, baseUrl) === null) return 'outside the app';
  if (FILE_LINK.test(relPath(href, baseUrl))) return 'a file, not a page';
  const words = [...SKIP_WORDS, ...skip].map((w) => String(w).toLowerCase());
  let address = href.toLowerCase();
  try {
    const u = new URL(href, baseUrl);
    address = `${u.pathname}${u.search}`.toLowerCase();
  } catch { /* keep the raw text */ }
  const text = label.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = words.find((w) => address.includes(w.replace(/\s+/g, '')) || address.includes(w.replace(/\s+/g, '-')) || address.includes(w.replace(/\s+/g, '_')) || (text && new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text)));
  return hit ? `looks destructive or ends the session ("${hit}")` : null;
}

/** A new crawl record. start = paths relative to the base URL. */
export function newCrawl({ baseUrl, start = [''], skip = [], maxPages = 200, roles = ['Visitor'] }) {
  return { base_url: baseUrl, started: null, roles, max_pages: maxPages, skip, start: start.map(strip), pages: {}, external_hosts: {}, skipped: [], files: [], truncated: false };
}

/** What happened when a role asked for a page: allowed, redirect-login, redirect or error. */
export function outcomeOf({ requested, finalUrl, status }, baseUrl, loginPaths = []) {
  if (status >= 400 || status === 0) return 'error';
  const asked = relPath(requested, baseUrl);
  const got = relPath(finalUrl, baseUrl);
  if (got === asked) return 'allowed';
  if (got !== null && loginPaths.some((l) => got === strip(l) || got.endsWith(`/${strip(l)}`))) return 'redirect-login';
  return 'redirect';
}

/**
 * Record one visit and return the links on it worth following ({ key, url }, one per page pattern). visit = { requested, finalUrl, status,
 * title, links: [{ href, label }], forms: [{ action, method, fields: [{ name, type, required, maxlength }] }] }.
 */
export function recordVisit(crawl, role, visit, { loginPaths = [] } = {}) {
  const base = crawl.base_url;
  const key = pageKey(visit.requested, base);
  const page = (crawl.pages[key] ??= { path: relPath(visit.requested, base), query: queryNames(visit.requested, base), example_query: new URL(visit.requested, base).search.replace(/^\?/, ''), found_by: role, roles: {}, title: null, forms: [], links_to: [] });
  const outcome = outcomeOf(visit, base, loginPaths);
  page.roles[role] = { outcome, status: visit.status, ...(outcome.startsWith('redirect') ? { landed_on: relPath(visit.finalUrl, base) ?? visit.finalUrl } : {}) };
  // server errors logged while the role asked for the page (only where a server log is configured): a page that answers
  // with a redirect and still logs an error kept running behind the redirect
  if (visit.serverErrors?.length) Object.assign(page.roles[role], { server_errors: visit.serverErrors.length, server_error: String(visit.serverErrors[0]).slice(0, 240) });
  const found = [];
  if (outcome !== 'allowed') {
    // what a redirect target or an error page shows belongs to that page, not this one; but the page a role is sent
    // to is a page users reach, so it is returned as one to visit in its own right
    const landed = outcome === 'error' ? null : pageKey(visit.finalUrl, base);
    return landed === null || landed === key ? found : [{ key: landed, url: new URL(visit.finalUrl, base).href }];
  }
  page.title ??= visit.title ?? null;
  for (const f of visit.forms ?? []) {
    const action = relPath(f.action || visit.requested, base);
    const form = { action: action ?? f.action, method: String(f.method || 'GET').toUpperCase(), fields: (f.fields ?? []).filter((x) => x.name).map(({ name, type = 'text', required = false, maxlength = null }) => ({ name, type, required: Boolean(required), maxlength })) };
    if (!page.forms.some((x) => JSON.stringify(x) === JSON.stringify(form))) page.forms.push(form);
  }
  for (const link of visit.links ?? []) {
    let host = null;
    try {
      host = new URL(link.href, base).hostname;
    } catch { /* not a URL */ }
    const reason = skipReason(link, { baseUrl: base, skip: crawl.skip });
    if (reason === 'a file, not a page') {
      const file = relPath(link.href, base);
      if (!crawl.files.includes(file)) crawl.files.push(file);
      continue;
    }
    if (reason === 'outside the app') {
      if (host && /^https?:/i.test(new URL(link.href, base).protocol)) (crawl.external_hosts[host] ??= []).includes(key) || crawl.external_hosts[host].push(key);
      continue;
    }
    if (reason) {
      if (reason !== 'not a page link' && !crawl.skipped.some((s) => s.href === link.href)) crawl.skipped.push({ href: link.href, label: (link.label ?? '').trim().slice(0, 60), on: key, reason });
      continue;
    }
    const k = pageKey(link.href, base);
    if (!page.links_to.includes(k)) page.links_to.push(k);
    // every link worth following, known or not: the caller keeps one visited list per role, because a page another
    // role already found can show this role links of its own
    if (!found.some((x) => x.key === k)) found.push({ key: k, url: new URL(link.href, base).href });
  }
  return found;
}

/**
 * The inventory endpoints of a crawl record: one per page pattern, with the methods seen (POST when a form posts to
 * it), query names, a query it was seen with, the forms on it and what each role got.
 */
export function crawlEndpoints(crawl) {
  const posts = new Map();
  for (const p of Object.values(crawl.pages)) for (const f of p.forms) if (f.method === 'POST') posts.set(f.action, [...(posts.get(f.action) ?? []), f]);
  const byPath = new Map();
  for (const p of Object.values(crawl.pages)) {
    const e = byPath.get(p.path) ?? { path: p.path, methods: ['GET'], params: {}, source: 'crawl', evidence: `crawl-app (${crawl.started ?? 'undated'})`, title: p.title, observed: {}, forms: [] };
    if (p.query.length) e.params.GET = [...new Set([...(e.params.GET ?? []), ...p.query])].sort();
    // the query a link arrived with. Information only: a link the crawl saw can write data (add to cart), so tests
    // never use it. They take values from target.yaml page_params or from an example the API spec declares.
    if (p.example_query && !e.seen_query) e.seen_query = p.example_query;
    // one path can be seen with several query shapes (book.php?id, book.php?bid): the role opened the page if any of
    // them opened, and a server error on any of them counts
    for (const [role, r] of Object.entries(p.roles)) {
      const prev = e.observed[role];
      const keep = prev?.outcome === 'allowed' ? prev : r;
      const errors = Math.max(prev?.server_errors ?? 0, r.server_errors ?? 0);
      e.observed[role] = errors ? { ...keep, server_errors: errors, server_error: keep.server_error ?? prev?.server_error ?? r.server_error } : keep;
    }
    e.forms.push(...p.forms);
    e.title ??= p.title;
    byPath.set(p.path, e);
  }
  for (const e of byPath.values()) {
    const incoming = posts.get(e.path) ?? [];
    if (incoming.length) {
      e.methods.push('POST');
      e.params.POST = [...new Set(incoming.flatMap((f) => f.fields.filter((x) => x.type !== 'file').map((x) => x.name)))].sort();
      const files = [...new Set(incoming.flatMap((f) => f.fields.filter((x) => x.type === 'file').map((x) => x.name)))].sort();
      if (files.length) e.params.FILES = files;
    }
    // a role may use a page it opened, or one that did its work and moved it on (add to cart → checkout): a redirect
    // that is not to a login page, the same reading the authorization tier uses for "allowed"
    e.reachable_by = Object.entries(e.observed).filter(([, r]) => r.outcome === 'allowed' || r.outcome === 'redirect').map(([role]) => role);
  }
  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** What the crawl saw each role get, one row per page and role: an observation for the analysts, not an expectation. */
export function observedMatrix(crawl) {
  const rows = [];
  for (const e of crawlEndpoints(crawl)) for (const role of crawl.roles) if (e.observed[role]) rows.push({ page: e.path, role, observed: e.observed[role].outcome, status: e.observed[role].status, landed_on: e.observed[role].landed_on ?? '', server_errors: e.observed[role].server_errors ?? 0 });
  return rows;
}
