// Deterministic payment executor: no model inside, no healing, no screenshots.
// It is the only module that imports the vault. It resolves cardRef just in time, types only into
// approved origins, wipes its copy, and returns { ok, last4, maskedError } and nothing else.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Frame, Page } from 'playwright';
import type { RunContext } from '../agent/context.js';
import { resolve as resolveCard, wipe, type CardSecret } from './vault.js';
import { maskedError } from '../security/redact.js';
import { norm } from '../payload.js';

export interface PaymentResult { ok: boolean; last4?: string; maskedError?: string }

/** Card fields may only be typed into these origins. Anything else stops the run. */
const CARD_ORIGINS = ['https://secure.tillpayments.com'];
const isTillOrigin = (o: string) => /^https:\/\/([\w-]+\.)*tillpayments\.com$/.test(o);
const origin = (u: string) => { try { return new URL(u).origin; } catch { return ''; } };

// ---------- idempotency ledger: never pay twice for the same job ----------

const ledgerFile = () => path.resolve('runs', 'payment-ledger.json');
type Ledger = Record<string, { state: string; at: string; transactionId?: string }>;
const readLedger = (): Ledger => (existsSync(ledgerFile()) ? JSON.parse(readFileSync(ledgerFile(), 'utf8')) : {});
export function recordPayment(jobId: string, state: string, transactionId?: string) {
  const l = readLedger();
  l[jobId] = { state, at: new Date().toISOString(), ...(transactionId ? { transactionId } : {}) };
  writeFileSync(ledgerFile(), JSON.stringify(l, null, 2));
}

// ---------- pre-pay checks ----------

/** Rule 7: before Pay Now, the order summary must match the payload (plan, price, address). */
async function checkOrderSummary(ctx: RunContext): Promise<string | undefined> {
  const raw = await summaryText(ctx.page); // main frame only: the card iframes are not part of this text
  const text = norm(raw);
  if (!text.includes(norm(ctx.job.plan.name))) return `order summary does not show plan "${ctx.job.plan.name}"`;
  const total = ctx.facts.cartTotal;
  const shown = raw.match(/grand total to pay today\s*\$\s*(\d[\d,]*\.\d{2})/i)?.[1];
  if (!total || !shown || Number(shown.replace(/,/g, '')) !== Number(total)) return `order summary total ($${shown ?? '?'}) does not match the cart total $${total ?? '?'}`;
  const a = ctx.job.connectionAddress.mainAddress;
  const street = norm(`${a.streetNumber} ${a.streetName}`);
  if (a.streetName && !text.includes(street)) ctx.warnings.push('service address is not shown on the payment page; plan and price were verified');
  return undefined;
}

async function summaryText(page: Page): Promise<string> {
  const t = await page.locator('body').innerText();
  const i = t.search(/order summary/i);
  return (i >= 0 ? t.slice(i, i + 300) : t.slice(0, 300)).replace(/\s+/g, ' ');
}

async function findCardFrames(page: Page, timeoutMs: number): Promise<{ pan: Frame; cvv: Frame } | { problem: string }> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    let pan: Frame | undefined, cvv: Frame | undefined;
    for (const f of page.frames()) {
      if (f === page.mainFrame()) continue;
      const title = (await (await f.frameElement().catch(() => null))?.getAttribute('title').catch(() => '')) || '';
      const isPan = /card number/i.test(title) || /\/pan\.html/.test(f.url());
      const isCvv = /security code|cvv/i.test(title) || /\/cvv\.html/.test(f.url());
      if (!isPan && !isCvv) continue;
      if (!CARD_ORIGINS.includes(origin(f.url()))) return { problem: `card iframe origin not approved (${origin(f.url()) || 'unknown'})` };
      if (isPan) pan = f; else cvv = f;
    }
    if (pan && cvv) return { pan, cvv };
    await page.waitForTimeout(1000);
  }
  return { problem: 'card iframes did not load within 60 s' };
}

// ---------- the executor ----------

export async function runPayment(ctx: RunContext): Promise<PaymentResult> {
  const { page, job } = ctx;
  let stage = 'preflight';
  let card: CardSecret | undefined;
  try {
    const prior = readLedger()[job.jobId];
    if (prior) {
      ctx.paymentState = prior.state === 'completed' ? 'completed' : 'unknown';
      return { ok: false, maskedError: `a payment for job ${job.jobId} was already ${prior.state} at ${prior.at}; manual reconciliation required, not retrying` };
    }
    stage = 'locate card fields';
    const frames = await findCardFrames(page, 60_000);
    if ('problem' in frames) return { ok: false, maskedError: frames.problem };
    const panInput = frames.pan.locator('input').first();
    const cvvInput = frames.cvv.locator('input').first();
    const nameInput = page.locator('#cardname');
    const expiryInput = page.locator('#expriy_month');
    for (const [what, l] of [['card number', panInput], ['security code', cvvInput], ['name on card', nameInput], ['expiry', expiryInput]] as const) {
      if (!(await l.isVisible().catch(() => false))) return { ok: false, maskedError: `${what} field not found; payment fields are never healed` };
    }

    // Rule 7, once the page has fully rendered: the order summary must match the payload before anything is typed.
    stage = 'order summary';
    await page.locator('#till_pay_submit').waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {});
    const mismatch = await checkOrderSummary(ctx);
    if (mismatch) {
      // Safe to log: read before any card field is touched, and only the main frame's summary block.
      ctx.log.info('order summary as shown', { summary: await summaryText(page) });
      return { ok: false, maskedError: `order summary check failed: ${mismatch}` };
    }


    if (ctx.dryRun) {
      ctx.log.info('order summary as shown', { summary: await summaryText(page) });
      return { ok: false, maskedError: 'dry run: summary and card-iframe origins verified; stopped before the card was resolved' };
    }

    // Just in time, scoped to this job, audited by the vault.
    stage = 'resolve card';
    card = resolveCard(job.payment.cardRef, job.jobId, 'payment-executor');
    const last4 = card.pan.slice(-4);
    const [mm, yy] = card.expiry.split('/');
    const expiry = `${mm.padStart(2, '0')}/${yy.length === 2 ? `20${yy}` : yy}`;

    stage = 'fill card fields';
    await nameInput.fill(job.payment.nameOnCard);
    await panInput.click();
    await panInput.pressSequentially(card.pan, { delay: 40 });
    await cvvInput.click();
    await cvvInput.pressSequentially(card.cvv, { delay: 40 });
    await expiryInput.click();
    await expiryInput.fill('');
    await expiryInput.pressSequentially(expiry.replace('/', ''), { delay: 60 });
    if ((await expiryInput.inputValue()).replace(/\D/g, '') !== expiry.replace(/\D/g, '')) {
      await expiryInput.fill(expiry);
    }
    // Verify without reading values out: compare digit counts only.
    const panDigits = await panInput.evaluate((e) => (e as HTMLInputElement).value.replace(/\D/g, '').length);
    const cvvDigits = await cvvInput.evaluate((e) => (e as HTMLInputElement).value.replace(/\D/g, '').length);
    const expiryOk = (await expiryInput.inputValue()).replace(/\D/g, '') === expiry.replace(/\D/g, '');
    const panLen = card.pan.length, cvvLen = card.cvv.length;
    wipe(card); card = undefined;
    if (panDigits !== panLen || cvvDigits !== cvvLen || !expiryOk) return { ok: false, maskedError: 'card fields did not accept the values' };

    stage = 'consents';
    for (const box of await page.locator('input[type=checkbox]').filter({ visible: true }).all()) {
      await box.check({ force: true }).catch(() => {});
      if (!(await box.isChecked())) return { ok: false, maskedError: 'a payment consent checkbox would not tick' };
    }

    // From the moment Pay Now is clicked the outcome is unknown until proven otherwise (double-charge risk).
    stage = 'pay now';
    recordPayment(job.jobId, 'submitting');
    ctx.paymentState = 'submitting';
    ctx.log.json('report.partial.json', { jobId: job.jobId, paymentState: 'unknown', note: 'Pay Now clicked; if this file is the last word, reconcile manually' });
    const payNow = page.locator('#till_pay_submit').or(page.getByRole('button', { name: 'Pay Now', exact: true })).filter({ visible: true }).first();
    await payNow.click();
    ctx.paymentState = 'unknown';
    recordPayment(job.jobId, 'unknown');

    stage = 'confirm modal';
    const modal = page.locator('[role=dialog], .modal.show').filter({ visible: true }).filter({ has: page.getByRole('button', { name: /pay now/i }) }).first();
    if (await modal.waitFor({ timeout: 10_000 }).then(() => true, () => false)) {
      for (const box of await modal.locator('input[type=checkbox]').all()) await box.check({ force: true }).catch(() => {});
      await modal.getByRole('button', { name: /pay now/i }).filter({ visible: true }).first().click();
      ctx.log.info('confirm modal: boxes ticked, Pay Now clicked');
    }

    stage = '3-D Secure';
    const outcome = await awaitOutcome(ctx);
    if (outcome === 'declined') { ctx.paymentState = 'declined'; recordPayment(job.jobId, 'declined'); return { ok: false, maskedError: 'payment declined by the gateway' }; }
    if (outcome !== 'confirmed') return { ok: false, maskedError: outcome };
    recordPayment(job.jobId, 'completed');
    return { ok: true, last4 };
  } catch (e) {
    // Never rethrow: Playwright errors can echo arguments. Only a masked message leaves this module.
    return { ok: false, maskedError: maskedError(stage, e) };
  } finally {
    if (card) wipe(card);
  }
}

/** Poll for up to 60 s: frictionless (transaction ID) or challenge (choose Authenticated, ECI 05, in test mode only). */
async function awaitOutcome(ctx: RunContext): Promise<'confirmed' | 'declined' | string> {
  const { page, job } = ctx;
  let challengeAnswered = false;
  const end = Date.now() + 60_000;
  while (Date.now() < end) {
    for (const p of page.context().pages()) {
      if (await p.getByText(/your transaction id/i).filter({ visible: true }).count().catch(() => 0)) {
        if (p !== page) await p.bringToFront();
        return 'confirmed';
      }
      if (await p.getByText(/payment (was )?(declined|failed|unsuccessful)|transaction (declined|failed)/i).filter({ visible: true }).count().catch(() => 0)) return 'declined';
      if (challengeAnswered) continue;
      for (const f of p.frames()) {
        const select = f.locator('select').filter({ has: f.locator('option', { hasText: /Authenticated/i }) }).first();
        if (!(await select.count().catch(() => 0))) continue;
        const o = origin(f.url());
        const portal = origin(job.portal.url);
        if (o !== portal && !isTillOrigin(o)) return `3-D Secure page on an unapproved origin (${o}); escalating`;
        if (!job.payment.cardRef.startsWith('vault://test-cards/')) return '3-D Secure challenge on a non-test card: a human must complete it';
        await select.selectOption({ label: (await select.locator('option', { hasText: /Authenticated \(ECI 05\)/i }).first().textContent())?.trim() || 'Authenticated (ECI 05)' });
        await f.getByRole('button', { name: /submit/i }).or(f.locator('input[type=submit]')).first().click();
        ctx.log.info(`3-D Secure challenge answered on ${o}: Authenticated (ECI 05)`);
        challengeAnswered = true;
      }
    }
    await page.waitForTimeout(1000);
  }
  return 'neither 3-D Secure nor a transaction ID appeared within 60 s; payment state unknown, reconcile manually';
}
