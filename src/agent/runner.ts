// The agent loop: observe -> decide (which goal applies now) -> act -> verify, under budgets.
import { chromium, type Browser } from 'playwright';
import { DEFAULT_BUDGETS, Escalate, Fail, type Budgets, type RunContext, type Status } from './context.js';
import { STEPS, RetryFromStart, type Step } from './steps.js';
import { clearPopups } from './popups.js';
import { scanForInjection } from '../browser/observe.js';
import { setPopupClearer } from '../browser/resolver.js';
import { RunLog } from '../log.js';
import { redact } from '../security/redact.js';
import { mutationScript } from '../mutation/mutate.js';
import { recordPayment } from '../payment/executor.js';
import type { Job } from '../payload.js';

export interface RunOptions {
  headless?: boolean;
  mutate?: boolean;
  useModel?: boolean;
  dryRun?: boolean;
  budgets?: Partial<Budgets>;
}

export interface Report {
  jobId: string;
  status: Status;
  transactionId?: string;
  accountNumber?: string;
  reason?: string;
  suggestedPatch?: unknown;
  completedSteps: string[];
  healingEvents: RunContext['healingEvents'];
  warnings: string[];
  paymentState: RunContext['paymentState'];
  cardLast4?: string;
  modelCalls: number;
  mutated: boolean;
  durationMs: number;
  evidenceDir: string;
}

setPopupClearer(clearPopups);

export async function runJob(job: Job, opts: RunOptions = {}): Promise<Report> {
  const log = new RunLog('runs', job.jobId);
  let browser: Browser | undefined;
  const ctx = { job, log, budgets: { ...DEFAULT_BUDGETS, ...opts.budgets }, startedAt: Date.now(), useModel: opts.useModel ?? true, dryRun: !!opts.dryRun,
    guarded: false, modelCalls: 0, completedSteps: [], healingEvents: [], warnings: [], paymentState: 'not-started', facts: {} } as unknown as RunContext;

  let status: Status = 'failed';
  let reason: string | undefined;
  let suggestedPatch: unknown;

  // Interrupted after Pay Now: never auto-retry, mark unknown for manual reconciliation (scenario 17).
  const onSignal = () => {
    if (ctx.paymentState === 'submitting' || ctx.paymentState === 'unknown') recordPayment(job.jobId, 'unknown');
    log.json('report.json', report('escalated', 'run interrupted', undefined));
    process.exit(130);
  };
  process.once('SIGINT', onSignal);

  function report(s: Status, why?: string, patch?: unknown): Report {
    return {
      jobId: job.jobId, status: s, transactionId: ctx.facts.transactionId, accountNumber: ctx.facts.accountNumber,
      reason: why, suggestedPatch: patch, completedSteps: ctx.completedSteps, healingEvents: ctx.healingEvents, warnings: ctx.warnings,
      paymentState: ctx.paymentState === 'submitting' ? 'unknown' : ctx.paymentState, cardLast4: ctx.facts.last4,
      modelCalls: ctx.modelCalls, mutated: !!opts.mutate, durationMs: Date.now() - ctx.startedAt, evidenceDir: log.dir,
    };
  }

  try {
    log.info(`job ${job.jobId} from ${job.source || 'payload'}${opts.mutate ? ' [MUTATED PORTAL]' : ''}`);
    browser = await chromium.launch({ headless: opts.headless ?? false });
    // No tracing, video or HAR, ever: they can record typed input and network bodies.
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    // tsx/esbuild wraps named functions with __name(); functions we evaluate in the page need it defined there.
    await context.addInitScript({ content: 'globalThis.__name = globalThis.__name || ((f) => f);' });
    if (opts.mutate) await context.addInitScript({ content: mutationScript(new URL(job.portal.url).origin) });
    ctx.page = await context.newPage();
    ctx.page.setDefaultNavigationTimeout(90_000);
    ctx.page.setDefaultTimeout(15_000);
    await openPortal(ctx);

    let last = '';
    let repeats = 0;
    let reloads = 0;
    for (let n = 1; ; n++) {
      if (n > ctx.budgets.maxSteps) throw new Escalate(`step budget of ${ctx.budgets.maxSteps} spent`);
      const step = await nextStep(ctx);
      repeats = step.id === last ? repeats + 1 : 0;
      last = step.id;

      log.info(`── step ${n}: ${step.id}  (${new URL(ctx.page.url()).pathname})`);
      if (!ctx.guarded) await scanForInjection(ctx);
      try {
        if (repeats > (step.maxRepeats ?? ctx.budgets.maxRetriesPerStep)) {
          if (step.shopFlow) throw new RetryFromStart(`stuck repeating step "${step.id}"`);
          throw new Escalate(`stuck repeating step "${step.id}"`);
        }
        await step.run(ctx);
      } catch (e) {
        // Handout step 5: if the address and plan flow fails, reload and retry it, up to 3 times.
        const retry = e instanceof RetryFromStart || (step.shopFlow && e instanceof Escalate && !/address not found|captcha/i.test(e.reason));
        if (!retry) throw e;
        if (reloads >= 3) throw new Fail(`${(e as Error).message}; gave up after 3 reloads of the address and plan flow`);
        reloads++;
        log.warn(`${(e as Error).message}; reloading and retrying the address and plan flow (${reloads}/3)`);
        ctx.facts.addressConfirmed = false;
        last = '';
        repeats = 0;
        await openPortal(ctx);
        continue;
      }
      ctx.completedSteps.push(step.id);
      if (!ctx.guarded) await ctx.page.screenshot({ path: log.path(`${String(n).padStart(2, '0')}-${step.id}.png`) }).catch(() => {});
      if (step.terminal) break;
    }
    status = 'success';
  } catch (e) {
    if (e instanceof Escalate) { status = 'escalated'; reason = e.reason; suggestedPatch = e.suggestedPatch; }
    else if (e instanceof Fail) { status = 'failed'; reason = e.reason; }
    else { status = 'failed'; reason = `unexpected error: ${(e as Error).message?.split('\n')[0]}`; }
    if (ctx.paymentState === 'unknown' && status === 'failed') status = 'escalated';
    log.error(`${status.toUpperCase()}: ${reason}`);
    await saveEvidence(ctx).catch(() => {});
  } finally {
    process.off('SIGINT', onSignal);
    await browser?.close().catch(() => {});
  }

  const r = report(status, reason, suggestedPatch);
  log.json('report.json', r);
  return r;
}

async function openPortal(ctx: RunContext) {
  // The portal is slow (HTML alone takes 15-40 s at times); wait for the response, then for the DOM.
  await ctx.page.goto(ctx.job.portal.url, { waitUntil: 'commit', timeout: 120_000 });
  await ctx.page.waitForLoadState('domcontentloaded', { timeout: 120_000 });
  if (!ctx.page.url().startsWith(new URL(ctx.job.portal.url).origin)) throw new Fail(`portal redirected to an unexpected URL: ${ctx.page.url()}`);
  await ctx.page.waitForTimeout(2500);
}

/** Decide: the first step whose precondition matches the live page. Unknown page -> re-observe, then escalate. */
async function nextStep(ctx: RunContext): Promise<Step> {
  for (let i = 0; i < 20; i++) {
    await clearPopups(ctx);
    for (const s of STEPS) if (await s.when(ctx).catch(() => false)) return s;
    await ctx.page.waitForTimeout(1500);
  }
  const headings = await ctx.page.getByRole('heading').filter({ visible: true }).allInnerTexts().catch(() => []);
  const buttons = ctx.guarded ? [] : await ctx.page.getByRole('button').filter({ visible: true }).allInnerTexts().catch(() => []);
  throw new Escalate(`no known step matches the current page ${new URL(ctx.page.url()).pathname}`, {
    hint: 'add a Step whose `when` matches this page, or extend an existing one',
    url: new URL(ctx.page.url()).pathname, headings: headings.slice(0, 8), buttons: buttons.map((b) => b.trim()).filter(Boolean).slice(0, 15),
  });
}

/** Redacted evidence. On guarded (payment) pages: URL and headings only, no screenshot and no ARIA (it would include input values). */
async function saveEvidence(ctx: RunContext) {
  if (!ctx.page) return;
  const url = ctx.page.url();
  if (ctx.guarded) {
    ctx.log.json('final-page.json', { url, headings: await ctx.page.getByRole('heading').filter({ visible: true }).allInnerTexts().catch(() => []) });
    return;
  }
  await ctx.page.screenshot({ path: ctx.log.path('final.png'), fullPage: true });
  const aria = await ctx.page.locator('body').ariaSnapshot().catch(() => '');
  ctx.log.json('final-page.json', { url, aria });
}
