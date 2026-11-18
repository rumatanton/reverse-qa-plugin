// Accessibility, generated from output/inventory.json: axe-core on every page, as a role allowed to open it. A legacy app starts
// with violations, so the first run records a baseline (A11Y_UPDATE=1); after that a test fails only when a page gets
// a new rule violation or more nodes for an existing rule. Every result is attached for the a11y findings.
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '../../support/fixtures.ts';
import { outputJson, outputCsv, loginPaths, pageUrl, OUTPUT, isDesktop } from '../../support/target.ts';
import { pagesLib } from '../../support/plugin.ts';
import { openPage } from '../../pages/base.page.ts';

const inventory = outputJson('inventory.json');
const matrix = outputCsv('role-matrix.csv');
const BASELINE = path.join(OUTPUT, 'a11y', 'baseline.json');
const baseline: Record<string, Record<string, number>> = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
const update = process.env.A11Y_UPDATE === '1';

test.describe('Accessibility (axe-core)', () => {
  // a scan of a long page (a list of every book, 8,000 px) takes far longer than a single-page check, more so on a busy machine
  test.describe.configure({ timeout: 90_000 });
  test.afterAll(() => {
    if (!update) return;
    fs.mkdirSync(path.dirname(BASELINE), { recursive: true });
    fs.writeFileSync(BASELINE, `${JSON.stringify(baseline, null, 2)}\n`);
  });
  for (const pg of inventory?.pages ?? []) {
    const p = pg.path;
    const role = pagesLib.roleForPage(pg, matrix, loginPaths());
    if (!role) continue; // no role may open it (or no matrix yet: the smoke tier fails on that)
    test.describe(() => {
      test(`${p} has no new accessibility violations @a11y @page:${p} @role:${role}`, async ({ rolePage }, testInfo) => {
        const page = await rolePage(role);
        const res = await openPage(page, pageUrl(p));
        expect(res?.status() ?? 500, `${p} answers for a role the role matrix allows`).toBeLessThan(400);
        const axe = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']);
        // axe finishes a scan in a blank tab it opens itself. A desktop app's windows are opened by the app, never by
        // a test, so there the scan stays in the window (what it leaves out: frames from another origin).
        if (isDesktop) axe.setLegacyMode(true);
        const result = await axe.analyze();
        await testInfo.attach('axe-results', { body: JSON.stringify(result.violations, null, 2), contentType: 'application/json' });
        const now = Object.fromEntries(result.violations.map((v) => [v.id, v.nodes.length]));
        if (update) {
          baseline[p] = now;
          return;
        }
        const known = baseline[p];
        expect(known, `no accessibility baseline for ${p}: record one with A11Y_UPDATE=1 and review it`).toBeTruthy();
        const worse = Object.entries(now).filter(([id, n]) => n > (known[id] ?? 0)).map(([id, n]) => `${id}: ${known[id] ?? 0} → ${n}`);
        expect(worse, `new accessibility violations on ${p}`).toEqual([]);
      });
    });
  }
});
