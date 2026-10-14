// Offline tests: the real agent (runner, steps, healing, payment executor) against fixture pages served locally.
// Covers the handout scenarios the live portal cannot be made to show on demand. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { runJob, type Report } from '../src/agent/runner.js';
import { parseJob } from '../src/payload.js';
import { redact } from '../src/security/redact.js';
import { valueAt } from '../src/payload.js';
import { scan } from '../src/security/leak-check.js';
import { groundWithModel } from '../src/llm/ground.js';
import { RunLog } from '../src/log.js';
import { DEFAULT_BUDGETS, type RunContext } from '../src/agent/context.js';
import { PORTAL, serveFixture, type Fixture } from './fixture-portal.js';

const OUT = path.resolve('runs-test');
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
// A throwaway vault and ledger for the tests, never the real ones.
process.env.VAULT_PATH = path.join(OUT, 'vault.json');
process.env.PAYMENT_LEDGER = path.join(OUT, 'payment-ledger.json');
writeFileSync(process.env.VAULT_PATH, JSON.stringify({ 'test-cards/visa-success': { pan: '4111111111111111', cvv: '123', expiry: '12/30' } }));

const sample = JSON.parse(readFileSync('payloads/sample-job.json', 'utf8'));
let n = 0;
function job(change: (j: typeof sample) => void = () => {}) {
  const j = structuredClone(sample);
  j.jobId = `offline-${Date.now()}-${n++}`;
  j.portal.url = `${PORTAL}/nbn/nbn-broadband#speeds`;
  change(j);
  return parseJob(j, 'offline test');
}

async function run(f: Fixture, opts: { dryRun?: boolean; useModel?: boolean; change?: (j: typeof sample) => void; job?: ReturnType<typeof parseJob> } = {}): Promise<Report & { log: string }> {
  const j = opts.job ?? job(opts.change);
  const r = await runJob(j, {
    headless: true, dryRun: opts.dryRun, useModel: opts.useModel ?? false, runsDir: OUT,
    budgets: { addressResultMs: 8000 }, prepare: (c) => serveFixture(c, f),
  });
  return { ...r, log: readFileSync(path.join(r.evidenceDir, 'run.log'), 'utf8') };
}

const T = { timeout: 240_000 };

// ---------- full journey ----------

test('clean journey with known portal quirks: silent plan click, cart drop after router, router label reset, wiped field, 3-D Secure challenge', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], planIgnoresFirstClick: true, routerDropsCartOnce: true, routerLabelResets: true, wipeFirstNameOnce: true, injection: true });
  assert.equal(r.status, 'success', r.reason ?? '');
  assert.equal(r.transactionId, '1791999144TCO');
  assert.equal(r.paymentState, 'completed');
  assert.equal(r.cardLast4, '1111');
  assert.equal(r.modelCalls, 0);
  assert.match(r.log, /click had no visible effect/, 'scenario 5: silent plan click retried');
  assert.match(r.log, /cart dropped to \$0\.00 after choosing the router/, 'scenario 6: plan re-selected');
  assert.match(r.log, /value did not stick, re-filling/, 'scenario 11: wiped field re-filled');
  assert.match(r.log, /3-D Secure challenge answered/);
  assert.doesNotMatch(r.log, /stuck repeating|reloading/);
  // A pressed router that reads "Choose" again is still selected: the router step must not run (and click) a second time.
  assert.equal(r.log.match(/step \d+: router/g)?.length, 1, 'router step ran more than once');
  assert.ok(r.warnings.some((w) => /prompt-injection/.test(w)), 'scenario 18: injection logged');
  assert.equal(scan([r.evidenceDir]).length, 0, 'leak check over the run output');
});

// ---------- address ----------

test('scenario 1: "Sorry! Address Not Found" is not treated as a suggestion; manual entry recovers', T, async () => {
  const r = await run({ suggestions: ['Sorry! Address Not Found'] }, { dryRun: true });
  assert.match(r.reason ?? "", /^dry run/, r.reason ?? "no reason");
  assert.match(r.log, /switching to manual address entry/);
  assert.doesNotMatch(r.log, /suggestion chosen: "Sorry/);
});

test('scenario 1: no suggestions and no structured address escalates with the typed value', T, async () => {
  const r = await run({ suggestions: [] }, { dryRun: true, change: (j) => {
    const a = j.connectionAddress.mainAddress; a.streetNumber = ''; a.streetName = ''; a.suburb = ''; a.postcode = '';
  } });
  assert.equal(r.status, 'escalated');
  assert.match(r.reason ?? '', /Address Not Found: no suggestions for "17 Rochester Way/);
});

test('scenario 2: the manual form keeps refusing the structured address: Address Not Found, no reload', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], afterPick: 'manual', manualRefuses: true }, { dryRun: true });
  assert.equal(r.status, 'escalated');
  assert.match(r.reason ?? '', /Address Not Found: the portal refused the structured address/);
  assert.doesNotMatch(r.log, /reloading/);
});

test('scenario 3: a suggestion in another suburb is never chosen when the payload has a structured address', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, DIANELLA WA 6059'] }, { dryRun: true });
  assert.match(r.log, /not choosing a different property/);
  assert.match(r.log, /switching to manual address entry/);
  assert.match(r.reason ?? "", /^dry run/, r.reason ?? "no reason");
});

test('slow portal: no address result is a timeout, so the shop flow reloads (3x) instead of escalating', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], resultNever: true }, { dryRun: true });
  assert.equal(r.status, 'failed');
  assert.match(r.log, /address check timed out.*reloading and retrying the address and plan flow \(3\/3\)/);
});

// ---------- plan, cart, popups ----------

test('scenario 4: plan card not found: reload and retry 3 times, then fail', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'] }, { dryRun: true, change: (j) => { j.plan.name = 'GOLD UNLIMITED'; } });
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /gave up after 3 reloads/);
});

test('scenario 7: cart still $0.00 at Order Now after 3 recovery attempts: fail with plan-missing', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], cartZeroAfterRouter: true }, { dryRun: true });
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /plan missing from cart: cart still \$0\.00 at Order Now after 3 recovery attempts/);
});

test('scenario 8: "Hold on!" (router without a plan) fails the run', T, async () => {
  const r = await run({ holdOn: true }, { dryRun: true });
  assert.equal(r.status, 'failed');
  assert.match(r.reason ?? '', /Hold on! popup: router in cart but no plan/);
});

test('CAPTCHA challenge escalates to a human', T, async () => {
  const r = await run({ captcha: true }, { dryRun: true });
  assert.equal(r.status, 'escalated');
  assert.match(r.reason ?? '', /CAPTCHA/);
});

// ---------- checkout ----------

test('scenario 9: email OTP escalates with the session state saved', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], otp: true }, { dryRun: true });
  assert.equal(r.status, 'escalated');
  assert.match(r.reason ?? '', /email OTP requested/);
  assert.ok(existsSync(path.join(r.evidenceDir, 'session-state.json')));
});

test('step order changed: donation before contact is handled by goal-based step selection', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], donationEarly: true }, { dryRun: true });
  assert.match(r.reason ?? "", /^dry run/, r.reason ?? "no reason");
  const i = r.completedSteps.indexOf('login');
  assert.equal(r.completedSteps[i + 1], 'donation');
  assert.ok(r.completedSteps.includes('contact'));
});

test('new mandatory field the payload can answer: L3 fills it from the payload', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], extraContactField: { kind: 'text', label: 'Confirm Email Address' } }, { dryRun: true });
  assert.match(r.reason ?? "", /^dry run/, r.reason ?? "no reason");
  const h = r.healingEvents.find((e) => e.level === 'L3');
  assert.ok(h, 'an L3 heal was recorded');
  assert.match(h!.changed, /customer\.email/);
  assert.match(h!.trustedBecause ?? '', /accepted the submission/);
});

test('new mandatory consent the payload cannot answer: escalate (L4), never invent consent', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], extraContactField: { kind: 'checkbox', label: 'I agree to receive marketing' } }, { dryRun: true });
  assert.equal(r.status, 'escalated');
  assert.match(r.reason ?? '', /new mandatory checkbox "I agree to receive marketing".*never invented/);
});

// ---------- payment ----------

test('scenario 14: unknown card reference escalates; nothing typed, no fallback', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'] }, { change: (j) => { j.payment.cardRef = 'vault://test-cards/nope'; } });
  assert.equal(r.status, 'escalated');
  assert.match(r.reason ?? '', /could not be resolved; never falling back/);
  assert.equal(r.paymentState, 'not-started');
});

test('scenario 15: card iframe on an unapproved origin escalates before the card is resolved', T, async () => {
  const r = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], cardOrigin: 'https://evil.example' });
  assert.equal(r.status, 'escalated');
  assert.match(r.reason ?? '', /card iframe origin not approved \(https:\/\/evil\.example\)/);
  assert.equal(r.paymentState, 'not-started');
});

test('scenarios 16 + 17: no 3-D Secure and no ID fails with state unknown; the same job is never paid again', T, async () => {
  const j = job();
  const first = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], payOutcome: 'nothing' }, { job: j });
  assert.equal(first.status, 'failed');
  assert.match(first.reason ?? '', /neither 3-D Secure nor a transaction ID appeared within 60 s/);
  assert.equal(first.paymentState, 'unknown');
  const ledger = JSON.parse(readFileSync(process.env.PAYMENT_LEDGER!, 'utf8'));
  assert.equal(ledger[j.jobId].state, 'unknown');

  const second = await run({ suggestions: ['17 ROCHESTER WAY, MEADOW SPRINGS WA 6210'], payOutcome: 'frictionless' }, { job: j });
  assert.equal(second.status, 'escalated');
  assert.match(second.reason ?? '', /already unknown .* not retrying/);
  assert.equal(scan([first.evidenceDir, second.evidenceDir]).length, 0, 'leak check');
});

// ---------- units ----------

test('redaction masks card numbers, CVVs and API keys', () => {
  const s = redact('pan 4111 1111 1111 1111 cvv: 123 key sk-abcdefghijklmnop AIzaSyA1234567890123456789012345');
  assert.doesNotMatch(s, /4111 1111 1111 1111|cvv: 123|sk-abcdef|AIzaSy/);
});

test('payload rules: card data is refused, and the model may only reference allow-listed payload fields', () => {
  assert.throws(() => job((j) => { j.payment.cardRef = '4111111111111111'; }));
  const j = job();
  assert.equal(valueAt(j, 'customer.email'), sample.customer.email);
  assert.equal(valueAt(j, 'payment.cardRef'), undefined);
});

test('model call retries a 429 rate limit, then succeeds', T, async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    if (calls === 1) { res.writeHead(429, { 'content-type': 'application/json' }); res.end('{"error":{"message":"rate limited"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"index":2,"confidence":0.9,"reason":"ok"}' } }] }));
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  Object.assign(process.env, { MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', MODEL_BASE_URL: `http://127.0.0.1:${port}/v1`, MODEL_RETRY_MS: '50' });
  try {
    const ctx = { page: { url: () => `${PORTAL}/x` }, log: new RunLog(OUT, 'model-retry'), budgets: DEFAULT_BUDGETS, modelCalls: 0, guarded: false, completedSteps: [] } as unknown as RunContext;
    const a = await groundWithModel(ctx, { key: 'k', goal: 'g', kind: 'click', candidates: [] }, []);
    assert.equal(a.index, 2);
    assert.equal(calls, 2);
  } finally { server.close(); }
});
