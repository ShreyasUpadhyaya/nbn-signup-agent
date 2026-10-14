// Act-then-verify primitives. Each one resolves the element through the healing ladder, acts,
// then checks an independent postcondition. Only a passing postcondition commits a heal.
import type { Locator } from 'playwright';
import { Escalate, checkTime, type RunContext } from './context.js';
import { build, commitHeal, rejectHeal, resolve, type Intent, type Resolved } from '../browser/resolver.js';
import { clearPopups } from './popups.js';
import { norm } from '../payload.js';

const sleep = (ctx: RunContext, ms: number) => ctx.page.waitForTimeout(ms);

/** Re-find a resolved element if the reactive page replaced the node since we resolved it. */
async function live(ctx: RunContext, r: Resolved): Promise<Locator> {
  if (await r.locator.count().catch(() => 0)) return r.locator;
  return build(ctx.page, r.spec).first();
}

/** The portal's sticky address bar covers the bottom of the viewport; keep targets in the middle. */
export async function centre(el: Locator) {
  await el.evaluate((e) => e.scrollIntoView({ block: 'center', inline: 'center' }), undefined, { timeout: 3000 }).catch(() => {});
  await el.page().waitForTimeout(350); // the sticky header shrinks while scrolling; let the layout settle
}

export async function poll(ctx: RunContext, check: () => Promise<boolean>, timeoutMs: number, everyMs = 500): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() > end) return false;
    checkTime(ctx);
    await sleep(ctx, everyMs);
  }
}

/**
 * Click, then wait for `done`. Retries with growing pauses (the portal's silent no-op clicks),
 * clearing popups in between. Returns false if the postcondition never passed.
 */
export async function clickUntil(
  ctx: RunContext, intent: Intent, done: () => Promise<boolean>,
  opts: { attempts?: number; waitMs?: number; pauseFirstMs?: number } = {},
): Promise<boolean> {
  const attempts = opts.attempts ?? ctx.budgets.maxRetriesPerStep;
  let r: Resolved | undefined;
  for (let i = 1; i <= attempts; i++) {
    await clearPopups(ctx);
    if (await done().catch(() => false)) { if (r) commitHeal(ctx, r, 'postcondition passed'); return true; }
    r ??= await resolve(ctx, intent);
    if (i === 1 && opts.pauseFirstMs) await sleep(ctx, opts.pauseFirstMs);
    const el = await live(ctx, r);
    await centre(el);
    const spec = r.spec;
    await el.click({ timeout: 6000 }).catch(async (e) => {
      const msg = String(e.message);
      const cover = msg.split('\n').reverse().find((l) => l.includes('intercepts pointer events'))?.trim().replace(/\s+/g, ' ').slice(0, 160);
      ctx.log.info(`click on ${intent.key} blocked (${cover ?? msg.split('\n')[0]}); trying other visible matches`);
      // L0: the portal renders duplicates (e.g. two Order Now buttons); one may sit under a sticky bar.
      for (const alt of (await build(ctx.page, spec).all()).slice(1)) {
        if (await alt.click({ timeout: 3000 }).then(() => true, () => false)) return;
      }
    });
    const ok = await poll(ctx, async () => { await clearPopups(ctx); return done(); }, (opts.waitMs ?? 4000) * i);
    if (ok) {
      commitHeal(ctx, r, 'postcondition passed after the click');
      return true;
    }
    ctx.log.info(`${intent.key}: click had no visible effect (attempt ${i}/${attempts})`);
  }
  if (r) rejectHeal(ctx, r, 'postcondition never passed');
  return false;
}

/** Fill a field and read it back until the value sticks (the portal's reactive framework can wipe fields). */
export async function fillField(ctx: RunContext, intent: Intent, value: string, opts: { typed?: boolean; expect?: string } = {}) {
  const r = await resolve(ctx, intent);
  const want = opts.expect ?? value;
  const sticks = async () => (await (await live(ctx, r)).inputValue()).trim() === want;
  const end = Date.now() + 20_000;
  while (Date.now() < end) {
    const el = await live(ctx, r);
    await centre(el);
    if (opts.typed) {
      await el.click();
      await el.fill('');
      await el.pressSequentially(value, { delay: 70 });
    } else {
      await el.fill(value);
    }
    await el.blur().catch(() => {});
    await sleep(ctx, 400);
    if (await sticks()) { commitHeal(ctx, r, 'value read back exactly as typed'); return; }
    ctx.log.info(`${intent.key}: value did not stick, re-filling`);
  }
  rejectHeal(ctx, r, 'value never stuck');
  throw new Escalate(`field "${intent.goal}" would not keep its value`);
}

/** Choose a <select> option whose normalised label matches `wanted`, else one matching `fallback`. */
export async function selectOption(ctx: RunContext, intent: Intent, wanted: string, fallback?: RegExp) {
  const r = await resolve(ctx, intent);
  const el = await live(ctx, r);
  const options = await el.locator('option').evaluateAll((os) => os.map((o) => ({ label: (o as HTMLOptionElement).label || o.textContent || '', value: (o as HTMLOptionElement).value })));
  const target = norm(wanted);
  const pick = options.find((o) => norm(o.label) === target)
    ?? options.find((o) => norm(o.label).includes(target) && target.length > 2)
    ?? (fallback ? options.find((o) => fallback.test(o.label)) : undefined);
  if (!pick) throw new Escalate(`no option for "${intent.goal}" matches the payload value`);
  if (norm(pick.label) !== target) ctx.warnings.push(`${intent.key}: no exact option for "${wanted}", chose "${pick.label.trim()}"`);
  await el.selectOption(pick.value);
  const ok = await poll(ctx, async () => (await (await live(ctx, r)).inputValue()) === pick.value, 3000);
  if (!ok) { rejectHeal(ctx, r, 'selection did not register'); throw new Escalate(`selection for "${intent.goal}" did not register`); }
  commitHeal(ctx, r, `selected option reads back as "${pick.label.trim()}"`);
}

/** Tick a checkbox or radio and verify it reads checked. */
export async function checkBox(ctx: RunContext, intent: Intent) {
  const r = await resolve(ctx, intent);
  for (let i = 0; i < 3; i++) {
    const el = await live(ctx, r);
    await centre(el);
    await el.check({ force: true, timeout: 5000 }).catch(async () => { await el.click({ force: true }).catch(() => {}); });
    await clearPopups(ctx);
    if (await poll(ctx, () => live(ctx, r).then((l) => l.isChecked()), 2000)) {
      commitHeal(ctx, r, 'control reads checked');
      return;
    }
  }
  rejectHeal(ctx, r, 'never read checked');
  throw new Escalate(`"${intent.goal}" would not stay checked`);
}

export async function urlMatches(ctx: RunContext, re: RegExp, timeoutMs: number) {
  return poll(ctx, async () => re.test(ctx.page.url()), timeoutMs);
}
