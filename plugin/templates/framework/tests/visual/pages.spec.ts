// Visual comparison, generated from output/inventory.json: full-page screenshots of every page, as a role allowed to open it.
// Project "visual" only (Chromium). Create or refresh the reference images with --update-snapshots, inside the
// official Playwright Docker image in CI so fonts and rendering match on every machine.
// Pages open with openPage's still variant: timers paused, animated images on their first frame (see pages/base.page.ts).
import { test, expect } from '../../support/fixtures.ts';
import { outputJson, outputCsv, loginPaths, pageUrl } from '../../support/target.ts';
import { pagesLib } from '../../support/plugin.ts';
import { openStill } from '../../pages/base.page.ts';
import { slug } from '../../support/matrix.ts';

const inventory = outputJson('inventory.json');
const matrix = outputCsv('role-matrix.csv');

test.describe('Visual: pages look as recorded', () => {
  // A long page (a list of every book) takes 2-3 s per full-page capture and a reference needs two matching captures.
  test.describe.configure({ timeout: 90_000 });
  for (const pg of inventory?.pages ?? []) {
    const p = pg.path;
    const role = pagesLib.roleForPage(pg, matrix, loginPaths());
    if (!role) continue; // no role may open it (or no matrix yet: the smoke tier fails on that)
    test.describe(() => {
      test(`${p} matches its reference screenshot @visual @page:${p} @role:${role}`, async ({ rolePage }, testInfo) => {
        const page = await rolePage(role);
        const { res, frozen, unreadable } = await openStill(page, pageUrl(p));
        expect(res?.status() ?? 500, `${p} answers for a role the role matrix allows`).toBeLessThan(400);
        if (frozen.length) testInfo.annotations.push({ type: 'held-on-first-frame', description: frozen.join(', ') });
        if (unreadable.length) testInfo.annotations.push({ type: 'image-not-readable', description: unreadable.join(', ') });
        await expect(page).toHaveScreenshot(`${slug(p)}.png`, { fullPage: true, maxDiffPixelRatio: 0.01, animations: 'disabled', timeout: 30_000 });
      });
    });
  }
});
