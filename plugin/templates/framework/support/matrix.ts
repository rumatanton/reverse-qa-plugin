// Decide whether one page × role response matches the role matrix. Pure, so the unit project tests it directly.
//   allowed        2xx, or a redirect that is not to a login page (e.g. add-to-cart → checkout)
//   redirect       3xx to a login page, AND no page content in the redirect body, AND no PHP fatal logged while the
//                  request ran (either one: execution after redirect, the page kept running behind the redirect)
//   denied         401 or 403: the app refuses the role and says so (what an API answers; a 5xx here is a crash, not a refusal)
//   error          4xx or 5xx
//   not-reachable  404
import { pagesLib } from './plugin.ts';

export type Observed = { status: number; location?: string | null; body?: string; serverFatals?: string[] };
export type Verdict = { ok: boolean; actual: string; reason: string };

/** Visible text of an HTML body: no tags, scripts or styles; whitespace collapsed. */
export function visibleText(html = ''): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const isLoginTarget: (location: string | null | undefined, loginPaths: string[]) => boolean = pagesLib.isLoginTarget;

export const LEAK_LIMIT = 200; // characters of visible text a redirect body may carry before it counts as a leak

export function evaluateCell(o: Observed, expected: string, loginPaths: string[] = []): Verdict {
  const redirect = o.status >= 300 && o.status < 400;
  const toLogin = redirect && isLoginTarget(o.location, loginPaths);
  const text = visibleText(o.body);
  const actual = redirect ? (toLogin ? 'redirect' : 'allowed') : o.status >= 400 ? (o.status === 404 ? 'not-reachable' : 'error') : 'allowed';
  switch (expected) {
    case 'allowed':
      return { ok: actual === 'allowed', actual, reason: actual === 'allowed' ? `HTTP ${o.status}` : `expected the page, got HTTP ${o.status}${o.location ? ` → ${o.location}` : ''}` };
    case 'redirect':
      if (!toLogin) return { ok: false, actual, reason: `expected a redirect to log in, got HTTP ${o.status}${o.location ? ` → ${o.location}` : ''} (${text.length} characters of page content)` };
      if (text.length > LEAK_LIMIT) return { ok: false, actual: 'redirect-with-content', reason: `redirected to ${o.location}, but the redirect body carries ${text.length} characters of page content (execution after redirect)` };
      if (o.serverFatals?.length) return { ok: false, actual: 'redirect-then-fatal', reason: `redirected to ${o.location}, but the page kept running and the server logged an error (execution after redirect): ${o.serverFatals[0]}` };
      return { ok: true, actual, reason: `HTTP ${o.status} → ${o.location}` };
    case 'denied':
      return { ok: o.status === 401 || o.status === 403, actual: o.status === 401 || o.status === 403 ? 'denied' : actual, reason: `HTTP ${o.status}${o.status === 401 || o.status === 403 ? '' : ' (expected 401 or 403)'}` };
    case 'error':
      return { ok: actual === 'error' || actual === 'not-reachable', actual, reason: `HTTP ${o.status}` };
    case 'not-reachable':
      return { ok: actual === 'not-reachable', actual, reason: `HTTP ${o.status}` };
    default:
      return { ok: false, actual, reason: `unknown expectation "${expected}" in role-matrix.csv` };
  }
}

/** A filesystem- and title-safe name for a page path. */
export function slug(p: string): string {
  return p.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}
