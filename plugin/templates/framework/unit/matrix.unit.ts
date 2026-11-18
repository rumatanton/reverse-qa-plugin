// Unit tests for the framework's own helpers. No browser, no app: run with RQA_SKIP_SETUP=1 (npm run selftest does).
import { test, expect } from '@playwright/test';
import { evaluateCell, visibleText, isLoginTarget, slug, LEAK_LIMIT } from '../support/matrix.ts';

const LOGIN = ['login.php', 'admin_login.php'];

test('allowed: 200, or a redirect that is not to a login page', () => {
  expect(evaluateCell({ status: 200, body: '<p>hi</p>' }, 'allowed', LOGIN).ok).toBe(true);
  expect(evaluateCell({ status: 302, location: 'checkout.php' }, 'allowed', LOGIN).ok).toBe(true);
  expect(evaluateCell({ status: 302, location: '../login.php' }, 'allowed', LOGIN)).toMatchObject({ ok: false, actual: 'redirect' });
});

test('redirect: to a login page with an empty body passes', () => {
  expect(evaluateCell({ status: 302, location: '../admin_login.php', body: '' }, 'redirect', LOGIN)).toEqual({ ok: true, actual: 'redirect', reason: 'HTTP 302 → ../admin_login.php' });
});

test('redirect: page content in the redirect body is execution after redirect', () => {
  const body = `<html><body>${'Orders: 31 Revenue: 4,250 '.repeat(20)}</body></html>`;
  const v = evaluateCell({ status: 302, location: 'login.php', body }, 'redirect', LOGIN);
  expect(v.ok).toBe(false);
  expect(v.actual).toBe('redirect-with-content');
  expect(v.reason).toMatch(/execution after redirect/);
});

test('redirect: a PHP fatal logged while the redirect was sent is execution after redirect', () => {
  const fatal = '[10-Nov-2026 15:02:11 UTC] PHP Fatal error:  Uncaught Error: Call to a member function fetch_assoc() on bool in /var/www/html/app/cart.php:31';
  const v = evaluateCell({ status: 302, location: 'login.php', body: '', serverFatals: [fatal] }, 'redirect', LOGIN);
  expect(v).toMatchObject({ ok: false, actual: 'redirect-then-fatal' });
  expect(v.reason).toContain('cart.php:31');
  expect(evaluateCell({ status: 302, location: 'login.php', body: '', serverFatals: [] }, 'redirect', LOGIN).ok, 'no fatal: a clean redirect').toBe(true);
});

test('redirect expected but the page is served (headers already sent) fails with the reason', () => {
  const v = evaluateCell({ status: 200, body: '<h1>Admin Home</h1>' }, 'redirect', LOGIN);
  expect(v).toMatchObject({ ok: false, actual: 'allowed' });
  expect(v.reason).toMatch(/expected a redirect to log in, got HTTP 200/);
});

test('denied: only 401 or 403 is a refusal; a server error or the page itself is not', () => {
  expect(evaluateCell({ status: 401, body: '{}' }, 'denied', LOGIN)).toEqual({ ok: true, actual: 'denied', reason: 'HTTP 401' });
  expect(evaluateCell({ status: 403, body: '{}' }, 'denied', LOGIN).ok).toBe(true);
  expect(evaluateCell({ status: 500, body: '' }, 'denied', LOGIN)).toMatchObject({ ok: false, actual: 'error', reason: 'HTTP 500 (expected 401 or 403)' });
  expect(evaluateCell({ status: 200, body: '{}' }, 'denied', LOGIN)).toMatchObject({ ok: false, actual: 'allowed' });
});

test('error and not-reachable', () => {
  expect(evaluateCell({ status: 403 }, 'error').ok).toBe(true);
  expect(evaluateCell({ status: 404 }, 'not-reachable').ok).toBe(true);
  expect(evaluateCell({ status: 200 }, 'not-reachable').ok).toBe(false);
  expect(evaluateCell({ status: 200 }, 'maybe').reason).toMatch(/unknown expectation/);
});

test('visibleText drops scripts, styles and tags; LEAK_LIMIT is the cut-off', () => {
  expect(visibleText('<style>p{}</style><script>var a=1</script><p>Hello&nbsp; <b>you</b></p>')).toBe('Hello you');
  expect(LEAK_LIMIT).toBe(200);
});

test('isLoginTarget and slug', () => {
  expect(isLoginTarget('/shop/admin_login.php?e=1', LOGIN)).toBe(true);
  expect(isLoginTarget('index.php', LOGIN)).toBe(false);
  expect(isLoginTarget('anything.php', [])).toBe(true);
  expect(slug('admin/view_products.php')).toBe('admin-view-products-php');
});
