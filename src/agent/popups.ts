// L0: popups are handled by a rule table that runs before every step and between locator retries.
// Known benign popups are dismissed, alarms stop the run, and an unknown popup is closed only if that is safe.
import { Escalate, Fail, type RunContext } from './context.js';
import { commitHeal } from '../browser/resolver.js';

type Rule = {
  heading: RegExp;
  action: (ctx: RunContext) => 'wait' | 'leave' | { click: RegExp } | { fail: string } | { escalate: string };
};

const RULES: Rule[] = [
  { heading: /hold tight/i, action: () => 'wait' },
  // The address step owns these two; it needs to read their options.
  { heading: /^result!?$|nearly there|check your address manually|manually enter your address/i, action: () => 'leave' },
  { heading: /heads up/i, action: () => ({ click: /^continue$/i }) },
  {
    heading: /planning to use your own wi-?fi router/i,
    action: (ctx) => ctx.job.normalised.router?.byo
      ? { click: /^agree and continue$/i }
      : { fail: 'portal thinks no router was chosen, but the job asked for one: cart integrity alarm' },
  },
  // Handout step 10: a router in the cart with no plan. Never order a modem alone.
  { heading: /hold on/i, action: () => ({ fail: 'Hold on! popup: router in cart but no plan; refusing to order a modem alone' }) },
];

const SAFE_CLOSE = /^(×|x|close|no thanks|dismiss|not now|maybe later|close .*)$/i;

async function visibleDialog(ctx: RunContext) {
  const dlg = ctx.page.locator('[role=dialog], [aria-modal=true]').filter({ visible: true }).first();
  if (!(await dlg.count().catch(() => 0))) return undefined;
  const headings = await dlg.getByRole('heading').filter({ visible: true }).allInnerTexts().catch(() => [] as string[]);
  return { dlg, heading: headings.map((h) => h.replace(/\s+/g, ' ').trim()).join(' / ') };
}

export async function clearPopups(ctx: RunContext): Promise<void> {
  await checkCaptcha(ctx);
  for (let i = 0; i < 4; i++) {
    const d = await visibleDialog(ctx);
    if (!d) return;
    const rule = RULES.find((r) => r.heading.test(d.heading));
    if (rule) {
      const a = rule.action(ctx);
      if (a === 'leave') return;
      if (a === 'wait') { await ctx.page.waitForTimeout(1000); continue; }
      if ('fail' in a) throw new Fail(a.fail);
      if ('escalate' in a) throw new Escalate(a.escalate);
      const btn = d.dlg.getByRole('link', { name: a.click }).or(d.dlg.getByRole('button', { name: a.click })).filter({ visible: true }).first();
      if (await btn.count()) {
        ctx.log.info(`popup "${d.heading}" -> ${a.click.source.replace(/[\^$]/g, '')}`);
        await btn.click({ timeout: 5000 }).catch(() => {});
        await ctx.page.waitForTimeout(800);
        continue;
      }
      return;
    }
    // Unknown popup: close it only through an obvious close control, and only if it holds no form fields.
    const fields = await d.dlg.locator('input:not([type=hidden]), select, textarea').filter({ visible: true }).count();
    const close = d.dlg.getByRole('button', { name: SAFE_CLOSE }).or(d.dlg.getByRole('link', { name: SAFE_CLOSE })).filter({ visible: true }).first();
    if (fields === 0 && (await close.count())) {
      const label = (await close.getAttribute('aria-label')) || (await close.innerText());
      await close.click({ timeout: 5000 }).catch(() => {});
      await ctx.page.waitForTimeout(600);
      const stillThere = await visibleDialog(ctx);
      if (stillThere?.heading === d.heading) return;
      commitHeal(ctx, {
        locator: close, spec: { by: 'role', role: 'button', name: label },
        heal: { intent: 'popup.dismiss', goal: 'clear an unexpected popup', level: 'L0', broke: `unexpected popup "${d.heading || '(no heading)'}" blocked the page`, changed: `closed it with "${label.trim()}"`, at: new Date().toISOString() },
      }, 'the popup is gone and it contained no form fields');
      continue;
    }
    ctx.log.warn(`unknown popup "${d.heading}" left open (no safe close control)`);
    return;
  }
}

/** A visible CAPTCHA challenge is never automated (R7). */
export async function checkCaptcha(ctx: RunContext) {
  for (const f of ctx.page.frames()) {
    if (!/recaptcha\/api2\/bframe|hcaptcha\.com.*challenge|challenges\.cloudflare/.test(f.url())) continue;
    const el = await f.frameElement().catch(() => undefined);
    if (el && (await el.isVisible().catch(() => false))) {
      const box = await el.boundingBox().catch(() => null);
      if (box && box.height > 100) throw new Escalate('CAPTCHA challenge shown; a human must complete it');
    }
  }
}
