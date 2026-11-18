// T0 smoke, generated from output/inventory.json: every page loads for a role that is allowed to open it, without a
// server error, a PHP fatal or PHP error text. The role comes from output/role-matrix.csv, or from code facts until the
// matrix exists (plugin lib/pages.mjs). What other roles get on a page is the T3 authorization tier's job. Runs first
// in run-suites; a failure stops the run.
import { test, expect } from '../../support/fixtures.ts';
import { outputJson, outputCsv, loginPaths, pageUrl } from '../../support/target.ts';
import { pagesLib } from '../../support/plugin.ts';
import { BasePage } from '../../pages/base.page.ts';

const inventory = outputJson('inventory.json');
const matrix = outputCsv('role-matrix.csv');

test.describe('T0 smoke: every page loads for its role', () => {
  // No skipped tests: a page gets a test only when some role may open it (pages no role may open are the T3 tier's
  // job), and a missing input fails here, in the first tier, instead of hiding pages from the run.
  test('every page has a role that may open it, or a role-matrix.csv that says none does @smoke', () => {
    expect(inventory, 'output/inventory.json: run scan-repo first').toBeTruthy();
    const unknown = inventory.pages
      .filter((p: any) => (matrix ? !matrix.some((c) => c.page === p.path) : !pagesLib.roleForPage(p, null, loginPaths())))
      .map((p: any) => p.path);
    expect(unknown, matrix ? 'pages missing from role-matrix.csv' : 'pages with a session guard and no role-matrix.csv to say who may open them (run workflow-analyst)').toEqual([]);
  });
  for (const p of inventory?.pages ?? []) {
    const role = pagesLib.roleForPage(p, matrix, loginPaths());
    if (!role) continue;
    test(`${p.path} loads for ${role} @smoke @page:${p.path} @role:${role}`, async ({ rolePage }) => {
      const page = await rolePage(role);
      const res = await new BasePage(page, pageUrl(p.path)).open();
      expect(res, 'a response').not.toBeNull();
      expect(res!.status(), `HTTP status of ${p.path}`).toBeLessThan(500);
    });
  }
});
