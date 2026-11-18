// Base page object: every page object extends it. Navigation is relative to the app's base URL (target.yaml), and
// every page checks that no PHP error text reached the browser.
import { expect, type Page, type Response } from '@playwright/test';

export const PHP_ERROR_TEXT = /(Fatal error|Parse error|Warning|Notice|Deprecated|Uncaught):?\s.*\bon line \d+/;

/**
 * Open a page and wait until the document has loaded. Waits on document.readyState rather than Playwright's load event:
 * a page that hands off to a blocked host while it loads (a form auto-submitted to the payment gateway) has its
 * hand-off answered 204 by the outbound guard and stays on screen, but Playwright never sees its load event.
 * After such a hand-off Chromium and Firefox still finish loading the page they stayed on; WebKit leaves it in
 * "loading" for good. So the wait ends on whichever comes first: the document is complete, or the page handed off to
 * a blocked host (a navigation answered 204) and has had a moment to settle.
 */
export async function openPage(page: Page, path: string): Promise<Response | null> {
  let onResponse: (r: Response) => void = () => {};
  const handedOff = new Promise<void>((resolve) => {
    onResponse = (r) => {
      if (r.status() === 204 && r.request().isNavigationRequest()) resolve();
    };
    page.on('response', onResponse);
  });
  try {
    const res = await page.goto(path, { waitUntil: 'commit' });
    const loaded = page.waitForFunction(() => document.readyState === 'complete');
    loaded.catch(() => {}); // the loser of the race below may end when the page closes
    await Promise.race([loaded, handedOff.then(() => page.waitForTimeout(300))]);
    return res;
  } finally {
    page.off('response', onResponse);
  }
}

/**
 * Open a page for a screenshot with everything that moves on its own held still, so two captures of it match.
 * Playwright's `animations: 'disabled'` stops CSS animations only; scripts on timers (typed or rotating text) and
 * animated images (GIF, WebP, APNG) keep moving. So: the page clock is paused at a fixed time before the page loads,
 * then run 2 s, which runs start-up timers the same way on every run; then every animated image, an <img> or a CSS
 * background, is replaced by its own first frame. The format comes from the file's first bytes, not its Content-Type
 * (apps serve PNGs named .jpg). An image the page cannot read (another site without CORS) or decode is left as it is
 * and listed in `unreadable`: if it moves, the screenshot comparison still fails. Returns the response and both lists.
 */
export async function openStill(page: Page, path: string): Promise<{ res: Response | null; frozen: string[]; unreadable: string[] }> {
  const start = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: start });
  await page.clock.pauseAt(start);
  const res = await openPage(page, path);
  await page.waitForLoadState('networkidle');
  await page.clock.runFor(2_000);
  const { frozen, unreadable } = await page.evaluate(holdFirstFrames);
  return { res, frozen, unreadable };
}

/** Runs in the page (self-contained): swaps each animated image for a still of its first frame (WebCodecs ImageDecoder). */
async function holdFirstFrames(): Promise<{ frozen: string[]; unreadable: string[] }> {
  const unreadable = new Set<string>();
  // only formats that can animate; JPEG and SVG images cannot
  const sniff = (b: Uint8Array) => {
    const ascii = (from: number, to: number) => String.fromCharCode(...b.slice(from, to));
    if (ascii(0, 4) === 'GIF8') return 'image/gif';
    if (b[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
    if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
    if (ascii(4, 8) === 'ftyp' && /avi[fs]/.test(ascii(8, 12))) return 'image/avif';
    return null;
  };
  const decodeFirst = async (url: string) => {
    let bytes: Uint8Array;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } catch {
      unreadable.add(url);
      return null;
    }
    const type = sniff(bytes);
    if (!type) return null;
    try {
      const decoder = new ImageDecoder({ data: bytes, type });
      await decoder.tracks.ready;
      if (!decoder.tracks.selectedTrack?.animated) { decoder.close(); return null; }
      const { image } = await decoder.decode({ frameIndex: 0 });
      const canvas = new OffscreenCanvas(image.displayWidth, image.displayHeight);
      canvas.getContext('2d')!.drawImage(image, 0, 0);
      image.close();
      decoder.close();
      const blobUrl = URL.createObjectURL(await canvas.convertToBlob());
      const img = new Image();
      img.src = blobUrl;
      await img.decode();
      return blobUrl;
    } catch {
      unreadable.add(url);
      return null;
    }
  };
  const stills = new Map<string, Promise<string | null>>();
  const still = (url: string) => {
    if (!stills.has(url)) stills.set(url, decodeFirst(url));
    return stills.get(url)!;
  };
  const frozen = new Set<string>();
  for (const img of Array.from(document.images)) {
    const url = img.currentSrc || img.src;
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) continue;
    const blobUrl = await still(url);
    if (!blobUrl) continue;
    img.removeAttribute('srcset');
    img.src = blobUrl;
    await img.decode();
    frozen.add(url);
  }
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    const bg = getComputedStyle(el).backgroundImage;
    if (!bg || bg === 'none') continue;
    let next = bg;
    for (const [, url] of bg.matchAll(/url\("([^"]+)"\)/g)) {
      if (url.startsWith('data:') || url.startsWith('blob:')) continue;
      const blobUrl = await still(url);
      if (!blobUrl) continue;
      next = next.replace(url, blobUrl);
      frozen.add(url);
    }
    if (next !== bg) el.style.setProperty('background-image', next, 'important');
  }
  return { frozen: [...frozen], unreadable: [...unreadable] };
}

export class BasePage {
  constructor(readonly page: Page, readonly path: string) {}

  async open(): Promise<Response | null> {
    const res = await openPage(this.page, this.path);
    await this.expectNoPhpErrors();
    return res;
  }

  async expectNoPhpErrors() {
    await expect(this.page.locator('body'), 'PHP error text in the page').not.toContainText(PHP_ERROR_TEXT);
  }
}
