// Which inventory pages a visitor can open, decided from code facts when no role matrix exists yet. Shared by the
// framework's smoke spec and run-perf so both pick pages the same way.

/** True when a redirect location points at one of the login pages (any location counts when none are known). */
export function isLoginTarget(location, loginPaths = []) {
  if (!location) return false;
  const p = location.split(/[?#]/)[0];
  return loginPaths.length === 0 || loginPaths.some((l) => p === l || p.endsWith(`/${l}`) || p.endsWith(`/${l.split('/').pop()}`));
}

/**
 * A page is guarded when one of its own session checks is followed within 3 lines by a redirect in the page itself, or
 * when it (or an include, such as a shared auth file) sends a server redirect to a login page. A session check alone
 * may only pick a menu, and JavaScript "redirects" are often menu links, so neither counts.
 */
export function isGuarded(page, loginPaths = []) {
  const own = page.redirects.some((r) => r.file === page.path && page.guards.some((g) => g.file === page.path && r.line >= g.line && r.line <= g.line + 3));
  return own || page.redirects.some((r) => loginPaths.length > 0 && isLoginTarget(r.url, loginPaths));
}

/** Pages a visitor can open (no guard), in inventory order. */
export function publicPages(inventory, loginPaths = []) {
  return (inventory?.pages ?? []).filter((p) => !isGuarded(p, loginPaths)).map((p) => p.path);
}

const ROLE_ORDER = ['Visitor', 'Customer', 'Admin'];

/**
 * The role a functional test should open a page as: the first role the role matrix allows (Visitor first), or, with no
 * matrix yet, Visitor for unguarded pages and null (skip) for guarded ones. What other roles get is the authz tier's job.
 */
export function roleForPage(page, matrix, loginPaths = []) {
  if (matrix) {
    const allowed = matrix.filter((c) => c.page === page.path && c.expected === 'allowed').map((c) => c.role);
    return allowed.sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99))[0] ?? null;
  }
  // no matrix yet. A page the crawl opened: the first role that got it. A page known only from an API spec: Visitor
  // when the spec asks for no credentials, otherwise wait for the matrix (the spec says "secured", not for whom).
  if (page.reachable_by?.length) return [...page.reachable_by].sort((a, b) => (ROLE_ORDER.indexOf(a) + 1 || 99) - (ROLE_ORDER.indexOf(b) + 1 || 99))[0];
  if (page.sources?.includes('openapi') && !page.sources.includes('pack')) return page.guards.length ? null : 'Visitor';
  return isGuarded(page, loginPaths) ? null : 'Visitor';
}

/** Login page paths declared in target.yaml test_accounts. */
export function loginPathsOf(def) {
  return Object.values(def.test_accounts ?? {}).map((a) => a?.login?.path).filter(Boolean);
}
