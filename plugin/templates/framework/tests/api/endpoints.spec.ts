// API tier, generated from output/inventory.json: every endpoint over HTTP with no browser, as a role allowed to use it.
// GET must not fail on the server; an endpoint that accepts POST must reject an empty form without a 5xx. Requests by
// roles that may NOT use an endpoint are the T3 authorization tier's job. The detailed API specs (parameters, values,
// database effects from 05-endpoint-catalog.md) are written next to this file by the generator.
import { test, expect } from '../../support/fixtures.ts';
import { outputJson, outputCsv, loginPaths, pageUrl, pageParams, needsExample, withServerFatals, caps } from '../../support/target.ts';
import { pagesLib } from '../../support/plugin.ts';
import { resetToSeed } from '../../support/seed.ts';

const inventory = outputJson('inventory.json');
const matrix = outputCsv('role-matrix.csv');
const pages: any[] = inventory?.pages ?? [];

// An endpoint with a path parameter ({id}) can only be called with a value: the example in the API spec, or
// page_params.<path>.path in target.yaml. This test names every endpoint still missing one, so none is left out
// without anyone seeing it.
const templated = pages.filter((p) => /\{[^}]+\}/.test(p.path));
if (templated.length) test('every endpoint with a path parameter has a value to call it with @api', () => {
  expect(templated.filter((p) => needsExample(p.path)).map((p) => p.path), 'endpoints with a path parameter and no value: add page_params.<path>.path in target.yaml, or an example in the API spec').toEqual([]);
});

test.describe('API: every endpoint answers without a server error', () => {
  for (const p of pages) {
    const role = pagesLib.roleForPage(p, matrix, loginPaths());
    if (!role) continue; // no role may use it (or no matrix yet: the smoke tier fails on that)
    if (!p.methods.includes('GET') || needsExample(p.path)) continue; // not a GET endpoint, or reported by the test above
    test.describe(() => {
      test(`GET ${p.path} as ${role} @api @page:${p.path} @role:${role}`, async ({ roleRequest }) => {
        const api = await roleRequest(role);
        const res = await api.get(pageUrl(p.path), { maxRedirects: 0 });
        expect(res.status(), `GET ${p.path}`).toBeLessThan(500);
      });
    });
  }
});

// The tests are independent (no serial mode: one failure must not stop the others from running). The form is posted
// to the URL a user is on when they submit it (target.yaml page_params), not to the bare page.
test.describe('API: POST endpoints reject an empty form', () => {
  test.afterAll(async () => {
    await resetToSeed(); // an empty POST may still write; put the (masked) seed and the test accounts back
  });
  for (const p of pages.filter((x) => x.methods.includes('POST'))) {
    const role = pagesLib.roleForPage(p, matrix, loginPaths());
    if (!role || needsExample(p.path)) continue; // no role may use it (or no matrix yet: the smoke tier fails on that)
    test.describe(() => {
      test(`POST ${p.path} with an empty form as ${role} @api @page:${p.path} @role:${role}`, async ({ roleRequest }) => {
        const api = await roleRequest(role);
        // an API takes a JSON body, a page takes a form: both are sent empty
        const res = await api.post(pageUrl(p.path), { ...(caps.kind === 'api' ? { data: {} } : { form: {} }), maxRedirects: 0 });
        expect(res.status(), `POST ${p.path} with no fields`).toBeLessThan(500);
      });
    });
  }
});

// A detail page opened without its parameters (a stale link, a hand-typed URL) must fail cleanly, not with a server
// error: no 5xx status and no server error in the log (a page that crashes after its header went out still answers 200).
// Where target.yaml page_params names the finding a bare request reproduces, the test documents it (test.fail).
test.describe('API: detail pages without their parameters', () => {
  for (const [page, params] of Object.entries(pageParams())) {
    const p = pages.find((x) => x.path === page);
    const role = p && pagesLib.roleForPage(p, matrix, loginPaths());
    if (!role || !params.query) continue; // only a page with a query has a bare form
    test(`GET ${page} without "${params.query}" as ${role} answers without a server error @api @page:${page} @role:${role}${params.without ? ` ${params.without}` : ''}`, async ({ roleRequest }) => {
      if (params.without) {
        test.fail(true, `known defect ${params.without}: no parameter validation`);
        test.info().annotations.push({ type: 'allow-server-error', description: `${page} the bare request is the defect under test` });
      }
      const api = await roleRequest(role);
      const { result: res, fatals } = await withServerFatals(() => api.get(page, { maxRedirects: 0 }));
      // a known defect is confirmed only by the assertion that names it (triage-failures --confirm-findings)
      const id = params.without ? `${params.without}: ` : '';
      expect(res.status(), `${id}GET ${page} with no parameters`).toBeLessThan(500);
      expect(fatals, `${id}GET ${page} with no parameters ends in a server error`).toEqual([]);
    });
  }
});
