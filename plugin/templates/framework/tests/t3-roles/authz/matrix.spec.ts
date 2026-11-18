// T3 authorization, generated from output/role-matrix.csv: each page × role cell is requested as that role, without
// following redirects, and compared with the expected outcome (allowed, redirect, denied, error, not-reachable). A redirect to log in must not carry the page in its
// body, and the page must not keep running behind it (a PHP fatal logged during the request): both are execution
// after redirect. Where today's app breaks the rule and a confirmed finding exists (column "finding"), the test is
// test.fail() with the finding ID: the suite stays green while the defect stays documented.
import { test, expect } from '../../../support/fixtures.ts';
import { outputCsv, loginPaths, pageUrl, needsExample, withServerFatals } from '../../../support/target.ts';
import { evaluateCell } from '../../../support/matrix.ts';

const matrix = outputCsv('role-matrix.csv');

test.describe('T3 authorization: role matrix', () => {
  for (const cell of matrix ?? []) {
    const finding = cell.finding?.trim();
    test(`${cell.page} as ${cell.role} → ${cell.expected}${finding ? ` ${finding}` : ''} @authz @page:${cell.page} @role:${cell.role}`, async ({ roleRequest }) => {
      if (finding) test.fail(true, `known defect ${finding}`);
      expect(needsExample(cell.page), `${cell.page} has a path parameter with no value: add page_params.<path>.path in target.yaml, or an example in the API spec`).toBe(false);
      const api = await roleRequest(cell.role);
      const get = () => api.get(pageUrl(cell.page), { maxRedirects: 0 });
      // only a redirect cell needs the log: did the page keep running behind the redirect?
      const { result: res, fatals: serverFatals } = cell.expected === 'redirect' ? await withServerFatals(get) : { result: await get(), fatals: [] };
      const verdict = evaluateCell({ status: res.status(), location: res.headers()['location'], body: await res.text(), serverFatals }, cell.expected, loginPaths());
      test.info().annotations.push({ type: 'observed', description: `${verdict.actual}: ${verdict.reason}` });
      // a known defect is confirmed only by the assertion that names it (triage-failures --confirm-findings)
      expect(verdict.ok, finding ? `${finding}: ${verdict.reason}` : verdict.reason).toBe(true);
    });
  }
});
