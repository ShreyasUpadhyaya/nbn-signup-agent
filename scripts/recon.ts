// Manual portal recon: you drive the browser, this saves a structural snapshot of each page.
// Usage: npm run recon            -> press Enter in this terminal to capture, type a label first if you like
// Output goes to recon/<nn>-<label>/ (gitignored). No tracing, video or HAR is ever enabled here.
import { chromium, type Page } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import path from 'node:path';

const PORTAL = 'https://test-tangerine.hipeely.com/nbn/nbn-broadband#speeds';
const OUT = path.resolve('recon');

// Belt and braces: mask anything that looks like a card number or a 3-4 digit CVV value attribute.
const redact = (s: string) =>
  s.replace(/\b(?:\d[ -]?){13,19}\b/g, '[REDACTED-PAN]').replace(/(cvv|cvc|security code)([^\n]{0,40}?)\b\d{3,4}\b/gi, '$1$2[REDACTED]');

async function inventory(page: Page) {
  // Interactive elements with every attribute a locator could use. Input VALUES are deliberately not read.
  return page.evaluate(() => {
    const sel = 'a,button,input,select,textarea,label,[role],[data-testid],[onclick]';
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .filter((el) => el.offsetParent !== null || el.getAttribute('type') === 'radio' || el.getAttribute('type') === 'checkbox')
      .map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        name: el.getAttribute('name') || undefined,
        type: el.getAttribute('type') || undefined,
        role: el.getAttribute('role') || undefined,
        testid: el.getAttribute('data-testid') || undefined,
        ariaLabel: el.getAttribute('aria-label') || undefined,
        placeholder: el.getAttribute('placeholder') || undefined,
        classes: el.className && typeof el.className === 'string' ? el.className.slice(0, 120) : undefined,
        text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80) || undefined,
        checked: (el as HTMLInputElement).checked || undefined,
      }));
  });
}

async function capture(page: Page, n: number, label: string) {
  const dir = path.join(OUT, `${String(n).padStart(2, '0')}-${label.replace(/[^\w-]+/g, '_') || 'page'}`);
  await mkdir(dir, { recursive: true });

  const pageOrigin = new URL(page.url()).origin;
  const frames = page.frames().map((f) => ({ name: f.name(), url: f.url(), origin: safeOrigin(f.url()) }));
  const foreignFrames = frames.filter((f) => f.origin && f.origin !== pageOrigin && f.origin !== 'null');

  await writeFile(path.join(dir, 'meta.json'), redact(JSON.stringify({
    capturedAt: new Date().toISOString(), url: page.url(), title: await page.title(), frames,
  }, null, 2)));
  await writeFile(path.join(dir, 'elements.json'), redact(JSON.stringify(await inventory(page), null, 2)));
  await writeFile(path.join(dir, 'aria.yaml'), redact(await page.locator('body').ariaSnapshot()));

  // Pages with cross-origin frames (the Till Payments card iframes) get no screenshot, ever.
  if (foreignFrames.length === 0) {
    await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: true });
  }
  console.log(`  saved ${dir}${foreignFrames.length ? `  (no screenshot: foreign frames ${foreignFrames.map((f) => f.origin).join(', ')})` : ''}`);
}

function safeOrigin(u: string) {
  try { return new URL(u).origin; } catch { return ''; }
}

async function main() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  context.on('page', (p) => console.log(`  [new tab opened] ${p.url()}  (3-D Secure?)`));
  page.on('dialog', (d) => console.log(`  [dialog] ${d.type()}: ${d.message()}`));
  // The portal's third-party scripts make the full "load" event slow; the DOM is usable well before it.
  page.setDefaultNavigationTimeout(90_000);
  await page.goto(PORTAL, { waitUntil: 'domcontentloaded' }).catch((e) =>
    console.log(`  initial load slow (${(e as Error).message.split('\n')[0]}); carry on in the browser`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  console.log('Drive the portal in the browser. Here: type a label + Enter to capture, "q" to quit.');
  for (let n = 1; ; n++) {
    const label = (await rl.question(`[${n}] label> `)).trim();
    if (label === 'q') break;
    const pages = context.pages();
    const target = pages[pages.length - 1]; // the newest tab, so a 3-D Secure tab gets captured too
    try { await capture(target, n, label); } catch (e) { console.log(`  capture failed: ${(e as Error).message.split('\n')[0]}`); n--; }
  }
  rl.close();
  await browser.close();
}

main();
