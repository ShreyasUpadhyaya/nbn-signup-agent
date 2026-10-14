// The journey as goals, not a fixed list. Each step says when it applies (detected from the URL and
// live page state) and what must be true afterwards. The runner always runs the first step that applies,
// so a popup, a reload or a reordered page is handled by whichever step matches what is on screen.
import type { Locator, Page } from 'playwright';
import { Escalate, Fail, type RunContext } from './context.js';
import { checkBox, clickUntil, fillField, poll, selectOption, urlMatches } from './actions.js';
import { clearPopups } from './popups.js';
import { fillNewMandatoryFields } from './new-fields.js';
import { build, commitHeal, resolve, type Intent } from '../browser/resolver.js';
import { norm } from '../payload.js';
import { runPayment } from '../payment/executor.js';

export interface Step {
  id: string;
  /** How many times in a row the runner may pick this step before declaring it stuck (default: maxRetriesPerStep). */
  maxRepeats?: number;
  /** Part of the address-and-plan flow on the shop page: on failure the runner reloads and retries (max 3). */
  shopFlow?: boolean;
  when: (ctx: RunContext) => Promise<boolean>;
  run: (ctx: RunContext) => Promise<void>;
  terminal?: boolean;
}

/** Thrown by the plan step when the address+plan flow should be reloaded and retried (handout step 5). */
export class RetryFromStart extends Error {}

const onShop = (ctx: RunContext) => /\/nbn\/nbn-broadband/.test(ctx.page.url());
const on = (re: RegExp) => async (ctx: RunContext) => re.test(ctx.page.url());

// ---------- shop-page state readers (the independent postconditions) ----------

export async function cartTotal(page: Page): Promise<number> {
  // Two sources: the Order Now button's label and the visible cart bar. Either can lag, so take the larger;
  // a real $0.00 cart shows $0.00 in both.
  const label = await page.getByRole('button', { name: /Order Now to proceed/i }).first().getAttribute('aria-label', { timeout: 2000 }).catch(() => null);
  const bar = await page.locator('#sticky-main-cart').innerText({ timeout: 2000 }).catch(() => '');
  const money = (m: RegExpMatchArray | null | undefined) => (m ? Number(m[1].replace(/,/g, '')) : 0);
  return Math.max(
    money(label?.match(/Amount to pay today:\s*\$(\d[\d,]*(?:\.\d{1,2})?)/i)),
    money(bar.match(/TOTAL TO PAY TODAY\s*\$(\d[\d,]*(?:\.\d{1,2})?)/i)),
  );
}

async function planSelected(ctx: RunContext) {
  return (await ctx.page.getByRole('button', { name: `${ctx.job.plan.name} has been selected` }).filter({ visible: true }).count()) > 0;
}

/**
 * Plan still in the cart. Right after the plan click we demand the strict check (button reads selected AND
 * cart > $0). Later the portal re-renders the plan buttons (e.g. after a router choice) and the label can lag,
 * so from then on a cart above $0 after we confirmed the plan is the signal (the handout's own check).
 * The payment executor re-verifies the plan name in the order summary before paying.
 */
async function planInCart(ctx: RunContext) {
  if (await planSelected(ctx)) return true;
  return !!ctx.facts.cartTotal && (await cartTotal(ctx.page)) > 0;
}

async function routerSelected(ctx: RunContext) {
  const r = ctx.job.normalised.router;
  if (!r) return true;
  // After a re-render the chosen option can read "Choose" while still pressed; clicking it again would deselect it.
  const panel = ctx.page.getByRole('tabpanel', { name: r.tab });
  return (await panel.getByRole('button').filter({ hasText: /^\s*Selected\s*$/ }).count()) > 0
    || (await panel.getByRole('button', { name: `Choose ${r.option}`, pressed: true }).count()) > 0;
}

// ---------- intents (locators are hints; the resolver heals when they break) ----------

const dialog = { by: 'css', selector: '[role=dialog]' } as const;

const I = {
  addressInput: {
    key: 'address.input', goal: 'the main address search box where the customer types their address', kind: 'fill',
    candidates: [
      { by: 'css', selector: '#autocomplete' },
      { by: 'role', role: 'textbox', name: 'Check your address to get started...', exact: true },
      { by: 'css', selector: 'main input[placeholder*="address" i]' },
    ],
  },
  manualAddressLink: {
    key: 'address.manualLink', goal: 'the link to enter the address manually because it cannot be found', kind: 'click',
    candidates: [
      { by: 'role', role: 'link', name: 'Enter your address manually' },
      { by: 'text', text: 'Can’t find your address?' },
    ],
  },
  buildYourPlan: {
    key: 'address.buildYourPlan', goal: 'the button in the address result popup that continues to building a plan', kind: 'click', within: dialog,
    candidates: [
      { by: 'role', role: 'link', name: 'Build Your Plan' },
      { by: 'css', selector: 'a.okbutton[href*="order-speeds"]' },
      { by: 'css', selector: 'a.okbutton' },
    ],
    deny: /pre-?order|register|clear cart|close/i,
  },
  plan: (name: string): Intent => ({
    key: `plan.choose[${norm(name)}]`, goal: `the button that chooses the "${name}" broadband plan`, kind: 'click',
    candidates: [
      { by: 'role', role: 'button', name: `Choose ${name} Plan` },
      { by: 'css', selector: `button[data-product-name="${name}" i]` },
    ],
    deny: /order now|clear|mobile|sim|router|eero|netcomm|modem|tooltip|information/i,
  }),
  routerTab: (tab: string): Intent => ({
    key: `router.tab[${tab}]`, goal: `the "${tab}" tab in the Add a router section`, kind: 'click',
    candidates: [{ by: 'role', role: 'tab', name: tab }, { by: 'text', text: tab, exact: true }],
  }),
  routerOption: (tab: string, option: string): Intent => ({
    key: `router.option[${option}]`, goal: `the button that chooses the "${option}" router option in the "${tab}" tab`, kind: 'click',
    candidates: [
      { by: 'role', role: 'button', name: `Choose ${option}` },
      { by: 'css', selector: `[role=tabpanel][aria-labelledby] button.add-to-cart, [role=tabpanel] button[aria-label^="Choose"]` },
    ],
    deny: /tooltip|information|plan/i,
  }),
  orderNow: {
    key: 'cart.orderNow', goal: 'the Order Now button in the sticky cart', kind: 'click',
    candidates: [
      { by: 'role', role: 'button', name: 'Order Now to proceed' },
      { by: 'role', role: 'button', name: 'Order Now' },
    ],
    deny: /save|email|clear/i,
  },
  email: {
    key: 'login.email', goal: 'the email address field on the checkout login page', kind: 'fill',
    candidates: [{ by: 'css', selector: '#login_email' }, { by: 'label', text: 'Email Address' }, { by: 'role', role: 'textbox', name: 'email' }],
  },
  emailNext: {
    key: 'login.next', goal: 'the Next button after the email address', kind: 'click',
    candidates: [{ by: 'css', selector: '#submit_email' }, { by: 'role', role: 'button', name: 'Next', exact: true }],
    deny: /login|verify/i,
  },
  salutation: { key: 'contact.salutation', goal: 'the salutation (title) dropdown', kind: 'select', candidates: [{ by: 'css', selector: '#salutation' }, { by: 'label', text: 'Salutation' }] },
  firstName: { key: 'contact.firstName', goal: 'the first name field', kind: 'fill', candidates: [{ by: 'css', selector: '#fname' }, { by: 'label', text: 'First Name' }] },
  lastName: { key: 'contact.lastName', goal: 'the last name field', kind: 'fill', candidates: [{ by: 'css', selector: '#lname' }, { by: 'label', text: 'Last Name' }] },
  mobile: { key: 'contact.mobile', goal: 'the mobile phone field', kind: 'fill', candidates: [{ by: 'css', selector: '#mobile' }, { by: 'label', text: 'Mobile Phone' }] },
  dob: { key: 'contact.dob', goal: 'the date of birth field', kind: 'fill', candidates: [{ by: 'css', selector: '#dob' }, { by: 'label', text: 'Date of Birth' }] },
  hearAbout: { key: 'contact.hearAbout', goal: 'the "How did you hear about us?" dropdown', kind: 'select', candidates: [{ by: 'css', selector: '#hear_about_us' }, { by: 'label', text: 'How did you hear about us' }] },
  privacy: {
    key: 'contact.privacy', goal: 'the privacy statement consent checkbox', kind: 'check',
    candidates: [{ by: 'css', selector: '#read_policy' }, { by: 'role', role: 'checkbox', name: 'Privacy Statement' }],
  },
  next: (page: string): Intent => ({
    key: `${page}.next`, goal: 'the Next button that submits this checkout page', kind: 'click',
    candidates: [{ by: 'role', role: 'button', name: 'Next', exact: true }, { by: 'css', selector: '#btn-address-transfer' }],
    deny: /apply|promo|back/i,
  }),
  billingSelfCare: {
    key: 'address.billingSelfCare', goal: 'the Self Care Portal billing option', kind: 'check',
    candidates: [{ by: 'css', selector: '#print' }, { by: 'label', text: 'Self Care Portal' }],
  },
  activation: (kind: 'New' | 'Transfer'): Intent => ({
    key: `connection.activation[${kind}]`, goal: `the "${kind}" activation type radio button`, kind: 'check',
    candidates: [
      { by: 'css', selector: `input[name=new_or_transfer][value="${kind === 'New' ? '100000000' : '100000001'}"]` },
      { by: 'role', role: 'radio', name: kind, exact: true },
    ],
  }),
  avcId: { key: 'connection.avcId', goal: 'the AVC ID field', kind: 'fill', candidates: [{ by: 'css', selector: '#avc_id' }, { by: 'label', text: 'AVC ID' }] },
  avcCheck: {
    key: 'connection.avcCheck', goal: 'the Check button next to the AVC ID field', kind: 'click',
    candidates: [{ by: 'role', role: 'button', name: 'Check', exact: true }],
  },
  provideLater: {
    key: 'connection.provideLater', goal: 'the "Provide Later" option for the AVC ID', kind: 'check',
    candidates: [{ by: 'css', selector: '#avcidProvideLater' }, { by: 'label', text: 'Provide Later' }],
  },
  provider: {
    key: 'connection.provider', goal: 'the current nbn provider dropdown', kind: 'select',
    candidates: [{ by: 'css', selector: '#new_or_transfer_provider' }, { by: 'label', text: 'Provider' }],
  },
  connectionDate: {
    key: 'connection.date', goal: 'the preferred connection date field', kind: 'fill',
    candidates: [{ by: 'css', selector: '#conntectiondate' }, { by: 'label', text: 'Preferred Connection Date' }],
  },
  nbnBoxUnsure: {
    key: 'connection.nbnBoxUnsure', goal: 'the "Unsure" answer to whether the nbn connection box is at the property', kind: 'check',
    candidates: [{ by: 'css', selector: '#radio-unsure' }, { by: 'label', text: 'Unsure' }],
  },
  processOrder: {
    key: 'connection.processOrder', goal: 'the Process Order & Pay button', kind: 'click',
    candidates: [{ by: 'css', selector: '#btn-transfer-number' }, { by: 'role', role: 'button', name: 'Process Order & Pay' }],
    deny: /apply|agent|comment/i,
  },
  donateNo: {
    key: 'donation.no', goal: 'the "No" answer to the donation question', kind: 'check',
    candidates: [{ by: 'css', selector: '#donate-no' }, { by: 'role', role: 'radio', name: 'No', exact: true }],
  },
} satisfies Record<string, Intent | ((...a: never[]) => Intent)>;

// ---------- Phase A: address ----------

async function visibleSuggestions(page: Page, inDialog: boolean) {
  const scope = inDialog ? page.locator('[role=dialog]') : page.locator('body');
  // The portal lists "Sorry! Address Not Found" as a suggestion when nothing matches; that is not an address.
  return scope.locator('.autocomplete-suggestion').filter({ visible: true }).filter({ hasNotText: /address not found|no results/i });
}

/** Normalise target and options (uppercase, no commas, full street types) and pick the closest. */
function bestMatch(target: string, options: string[]): { index: number; exact: boolean } {
  const t = norm(target);
  const tokens = new Set(t.split(' '));
  let best = { index: -1, score: 0, exact: false };
  options.forEach((o, index) => {
    const n = norm(o);
    if (n === t) { if (!best.exact) best = { index, score: 1, exact: true }; return; }
    const ot = n.split(' ');
    const score = ot.filter((w) => tokens.has(w)).length / Math.max(tokens.size, ot.length);
    if (!best.exact && score > best.score) best = { index, score, exact: false };
  });
  return best;
}

async function chooseSuggestion(ctx: RunContext, inDialog: boolean): Promise<boolean> {
  if (!inDialog) await clearPopups(ctx);
  const sugg = await visibleSuggestions(ctx.page, inDialog);
  const texts = await sugg.allInnerTexts();
  if (!texts.length) return false;
  const a = ctx.job.connectionAddress.mainAddress;
  // With a structured address, a suggestion in another suburb or postcode is a different property: never pick it.
  const must = ctx.job.normalised.hasStructuredAddress ? [a.suburb, a.postcode].map(norm) : [];
  const allowed = texts.map((t, i) => ({ t, i })).filter(({ t }) => must.every((m) => norm(t).includes(m)));
  if (!allowed.length) {
    ctx.log.warn(`no suggestion is in ${a.suburb} ${a.postcode} (${texts.length} offered); not choosing a different property`);
    return false;
  }
  const { index, exact } = bestMatch(a.fullAddress, allowed.map((x) => x.t));
  const pick = allowed[index >= 0 ? index : 0].i;
  if (!exact) ctx.warnings.push(`address: no exact suggestion; chose "${texts[pick].trim()}" from ${texts.length}`);
  ctx.log.info(`address suggestion chosen: "${texts[pick].trim()}"${exact ? '' : ' (closest match)'}`);
  await sugg.nth(pick).click();
  return true;
}

async function manualAddress(ctx: RunContext) {
  const a = ctx.job.connectionAddress.mainAddress;
  if (!ctx.job.normalised.hasStructuredAddress) {
    throw new Escalate(`Address Not Found: no suggestions for "${a.fullAddress}" and no structured address to fall back on`);
  }
  ctx.log.info('switching to manual address entry');
  if (!(await ctx.page.locator('#streetno').filter({ visible: true }).count())) {
    await clickUntil(ctx, I.manualAddressLink, async () => (await ctx.page.locator('#streetno').filter({ visible: true }).count()) > 0, { attempts: 2 });
  }
  const f = (key: string, sel: string, label: string, v: string): Promise<void> => v
    ? fillField(ctx, { key: `manual.${key}`, goal: `the ${label} field in the manual address form`, kind: 'fill', candidates: [{ by: 'css', selector: sel }, { by: 'label', text: label }] }, v)
    : Promise.resolve();
  await f('unit', '#unitno', 'Unit Number', a.unitNumber);
  await f('streetNumber', '#streetno', 'Street Number', a.streetNumber);
  await f('streetName', '#streetname', 'Street Name', a.streetName);
  await selectOption(ctx, { key: 'manual.streetType', goal: 'the street type dropdown', kind: 'select', candidates: [{ by: 'css', selector: '#streettype' }, { by: 'label', text: 'Street Type' }] }, ctx.job.normalised.streetType);
  await f('suburb', '#suburb', 'Town/Suburb', a.suburb);
  await selectOption(ctx, { key: 'manual.state', goal: 'the state dropdown', kind: 'select', candidates: [{ by: 'css', selector: '#state' }, { by: 'label', text: 'State' }] }, a.state);
  await f('postcode', '#postcode', 'Postcode', a.postcode);
  const find = await resolve(ctx, { key: 'manual.find', goal: 'the Find Address button', kind: 'click', candidates: [{ by: 'css', selector: '#manual-address-btn' }, { by: 'role', role: 'button', name: 'Find Address' }] });
  await find.locator.click();
}

/** Waits for the address check to finish, handling disambiguation and the manual form. Never reloads. */
async function awaitAddressResult(ctx: RunContext, allowManual: boolean) {
  const end = Date.now() + ctx.budgets.addressResultMs;
  let manualDone = false;
  while (Date.now() < end) {
    if (await build_(ctx).count()) return;
    const heading = (await ctx.page.locator('[role=dialog]').filter({ visible: true }).getByRole('heading').filter({ visible: true }).allInnerTexts().catch(() => [])).join(' ');
    if (/nearly there/i.test(heading)) {
      ctx.log.info('"Nearly there!" disambiguation popup');
      await chooseSuggestion(ctx, true);
    } else if (/check your address manually|enter your address/i.test(heading) && (await ctx.page.locator('#streetno').filter({ visible: true }).count())) {
      if (!allowManual || manualDone) throw new Escalate('Address Not Found: the portal refused the structured address');
      await manualAddress(ctx); manualDone = true;
    } else if (/not (yet )?available|sorry|register (your )?interest|couldn.t find/i.test(heading)) {
      throw new Escalate(`Address Not Found / not serviceable: "${heading.trim()}"`);
    }
    await clearPopups(ctx);
    await ctx.page.waitForTimeout(1000);
  }
  // A slow portal, not a refusal: reload and retry the address and plan flow (up to 3 times).
  throw new RetryFromStart(`address check timed out: no result popup within ${ctx.budgets.addressResultMs / 1000} s`);
}
const build_ = (ctx: RunContext) => ctx.page.locator('[role=dialog]').getByRole('link', { name: /build your plan|see plans/i }).filter({ visible: true })
  .or(ctx.page.locator('[role=dialog] a.okbutton').filter({ visible: true }));

const shotCount = new WeakMap<RunContext, number>();

/**
 * Evidence for a step, taken once its work is done and just before the click that leaves the page.
 * Cropped to the area the step worked on: from `anchor`, walk up to the nearest dialog, or the first
 * container at least `minWidth` wide, or holding `minInputs` form controls. Never on guarded pages.
 */
async function snap(ctx: RunContext, label: string, anchor: Locator, area: { minWidth?: number; minInputs?: number } = {}) {
  if (ctx.guarded) return;
  const n = (shotCount.get(ctx) ?? 0) + 1;
  shotCount.set(ctx, n);
  const path = ctx.log.path(`${String(n).padStart(2, '0')}-${label}.png`);
  // Hide whatever floats over the page (header, cart bar, chat widgets), so it is not painted over the area.
  const hideFloating = () => ctx.page.evaluate(() => {
    for (const e of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
      const pos = getComputedStyle(e).position;
      if ((pos === 'fixed' || pos === 'sticky') && !e.closest('[role=dialog],.modal') && !e.querySelector('[data-agent-shot]') && !e.hasAttribute('data-agent-shot')) {
        e.setAttribute('data-agent-hidden', e.style.visibility);
        e.style.setProperty('visibility', 'hidden', 'important');
      }
    }
  }).catch(() => {});
  const restoreFloating = () => ctx.page.evaluate(() => {
    document.querySelectorAll<HTMLElement>('[data-agent-hidden]').forEach((e) => {
      e.style.visibility = e.getAttribute('data-agent-hidden') || '';
      e.removeAttribute('data-agent-hidden');
    });
  }).catch(() => {});
  try {
    const found = await anchor.first().evaluate((el, a) => {
      document.querySelectorAll('[data-agent-shot]').forEach((x) => x.removeAttribute('data-agent-shot'));
      const controls = 'input:not([type=hidden]),select,textarea';
      for (let p: Element | null = el, i = 0; p && p !== document.body && i < 15; p = p.parentElement, i++) {
        const hit = p.matches('[role=dialog],.modal-content')
          || (!!a.minWidth && p.getBoundingClientRect().width >= a.minWidth)
          || (!!a.minInputs && p.querySelectorAll(controls).length >= a.minInputs);
        if (hit) { p.setAttribute('data-agent-shot', ''); return true; }
      }
      return false;
    }, area, { timeout: 3000 });
    if (found) {
      const area = ctx.page.locator('[data-agent-shot]');
      await area.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await ctx.page.waitForTimeout(500); // the portal repaints styled controls (e.g. the privacy tick) a moment after scrolling
      await hideFloating();
      // animations: 'disabled' shows animated controls (the portal's tick marks) in their final state.
      await area.screenshot({ path, animations: 'disabled', timeout: 5000 }).finally(restoreFloating);
      return;
    }
  } catch { /* anchor gone or not visible: fall back to what is on screen */ }
  await ctx.page.screenshot({ path, animations: 'disabled' }).catch(() => {});
}

const address: Step = {
  id: 'address',
  shopFlow: true,
  when: async (ctx) => onShop(ctx) && !ctx.facts.addressConfirmed,
  run: async (ctx) => {
    const a = ctx.job.connectionAddress.mainAddress;
    // A result popup may already be showing (e.g. after a re-plan); only type if it is not.
    if (!(await build_(ctx).count())) {
      const box = await resolve(ctx, I.addressInput, { timeoutMs: 20_000 });
      await box.locator.click();
      await box.locator.fill('');
      await box.locator.pressSequentially(a.fullAddress, { delay: 80 }); // one key at a time so the suggestion API fires
      // Read back through a fresh lookup: the element may have been re-rendered while we typed.
      const typed = (await (await resolve(ctx, I.addressInput)).locator.inputValue()).trim();
      if (norm(typed) !== norm(a.fullAddress)) throw new Escalate('address box did not keep the typed address');
      commitHeal(ctx, box, 'the address box reads back the typed address');

      const gotSuggestions = await poll(ctx, async () => (await (await visibleSuggestions(ctx.page, false)).count()) > 0, 30_000);
      if (!gotSuggestions) ctx.log.warn(`no suggestions within 30 s for "${typed}"`);
      if (!gotSuggestions || !(await chooseSuggestion(ctx, false))) await manualAddress(ctx);
    }
    await awaitAddressResult(ctx, true);
    await ctx.page.waitForTimeout(1500); // the handout's pause before Build Your Plan
    await snap(ctx, 'address', build_(ctx));
    const ok = await clickUntil(ctx, I.buildYourPlan, async () => !(await build_(ctx).count()), { attempts: 3 });
    if (!ok) throw new Escalate('Build Your Plan did not close the address popup');
    ctx.facts.addressConfirmed = true;
  },
};

// ---------- Phase A/B: plan, router, cart ----------

async function selectPlan(ctx: RunContext) {
  const ok = await clickUntil(ctx, I.plan(ctx.job.plan.name), async () => (await planSelected(ctx)) && (await cartTotal(ctx.page)) > 0,
    { attempts: 5, waitMs: 3000 });
  if (!ok) throw new RetryFromStart(`plan "${ctx.job.plan.name}" could not be selected`);
  ctx.facts.cartTotal = (await cartTotal(ctx.page)).toFixed(2);
  ctx.log.info(`plan selected: "${ctx.job.plan.name} has been selected", cart $${ctx.facts.cartTotal}`);
}

const plan: Step = {
  id: 'plan',
  shopFlow: true,
  when: async (ctx) => onShop(ctx) && !!ctx.facts.addressConfirmed && !(await planInCart(ctx)),
  run: async (ctx) => {
    await selectPlan(ctx);
    const chosen = ctx.page.getByRole('button', { name: `${ctx.job.plan.name} has been selected` })
      .or(ctx.page.locator('button[data-product-type="speed"]').filter({ hasText: /selected/i })).filter({ visible: true });
    await snap(ctx, 'plan', chosen, { minWidth: 1000 }); // the row of plan cards
  },
};

const router: Step = {
  id: 'router',
  shopFlow: true,
  when: async (ctx) => onShop(ctx) && !!ctx.job.normalised.router && (await planInCart(ctx)) && !(await routerSelected(ctx)),
  run: async (ctx) => {
    const r = ctx.job.normalised.router!;
    const tabSelected = async () => (await ctx.page.getByRole('tab', { name: r.tab, selected: true }).count()) > 0;
    // The page re-renders the router section after a plan change and can snap back to the first tab,
    // so the tab is re-checked before every attempt at the option.
    let selected = false;
    for (let i = 1; i <= 3 && !selected; i++) {
      await ctx.page.waitForTimeout(1000 * i);
      if (!(await clickUntil(ctx, I.routerTab(r.tab), tabSelected, { attempts: 3 }))) throw new Escalate(`router tab "${r.tab}" would not open`);
      if (!r.byo) {
        // Outright purchase, as the legacy script does.
        const outright = ctx.page.getByRole('tabpanel', { name: r.tab }).getByRole('radio', { name: /outright/i }).filter({ visible: true }).first();
        if (await outright.count()) await outright.check({ force: true }).catch(() => {});
      }
      // Known flaky panel: if the option is not on screen yet, re-open the tab rather than escalate to the model.
      const option = I.routerOption(r.tab, r.option);
      const visible = await poll(ctx, async () => (await build(ctx.page, option.candidates[0]).count()) > 0, 5000);
      if (i < 3 && !visible) { ctx.log.info(`router option not visible yet (attempt ${i}); re-opening the tab`); continue; }
      selected = await clickUntil(ctx, option, () => routerSelected(ctx), { attempts: 1, waitMs: 4000 });
    }
    if (!selected) throw new Escalate(`router option "${r.option}" did not become Selected`);
    // Known portal bug: choosing a modem can reset the cart to $0.00. The cart label also updates late,
    // so give it time to settle before deciding it really dropped; then re-select the plan.
    const settled = await poll(ctx, async () => (await cartTotal(ctx.page)) > 0, 6000);
    if (!settled) {
      ctx.log.warn(`cart dropped to $${(await cartTotal(ctx.page)).toFixed(2)} after choosing the router; re-selecting the plan`);
      await selectPlan(ctx);
    }
    const routerCard = ctx.page.getByRole('tabpanel', { name: r.tab }).getByRole('button').filter({ hasText: /^\s*Selected\s*$/ }).filter({ visible: true });
    await snap(ctx, 'router', routerCard, { minWidth: 1000 }); // the router section
  },
};

const orderNow: Step = {
  id: 'orderNow',
  shopFlow: true,
  when: async (ctx) => onShop(ctx) && (await planInCart(ctx)) && (await routerSelected(ctx)),
  run: async (ctx) => {
    for (let i = 1; (await cartTotal(ctx.page)) <= 0 || !(await planInCart(ctx)); i++) {
      if (i > 3) throw new Fail('plan missing from cart: cart still $0.00 at Order Now after 3 recovery attempts');
      ctx.log.warn(`plan missing from cart before Order Now (recovery ${i}/3)`);
      // Scenario 7: these recoveries happen here, not by reloading; three failures stop the run.
      try { await selectPlan(ctx); } catch (e) { if (!(e instanceof RetryFromStart)) throw e; }
    }
    ctx.facts.cartTotal = (await cartTotal(ctx.page)).toFixed(2);
    await snap(ctx, 'orderNow', ctx.page.getByText(/^\s*order summary\s*$/i).filter({ visible: true }), { minWidth: 900 }); // the order summary
    // The BYO-router popup is answered by the popup rules ("Agree and Continue"); Hold on! fails the run.
    const ok = await clickUntil(ctx, I.orderNow, () => urlMatches(ctx, /\/checkout\//, 1500), { attempts: 3, waitMs: 5000 });
    if (!ok) throw new Escalate('Order Now did not open checkout');
  },
};

// ---------- Phase C: checkout identity and contact ----------

const login: Step = {
  id: 'login',
  when: on(/\/checkout\/login/),
  run: async (ctx) => {
    await fillField(ctx, I.email, ctx.job.customer.email);
    await ctx.page.waitForTimeout(800);
    await snap(ctx, 'login', ctx.page.locator('input[type=email]').filter({ visible: true }), { minWidth: 400 });
    const otp = ctx.page.locator('#otp_code').or(ctx.page.getByRole('textbox', { name: /otp|one[- ]time|verification code/i })).filter({ visible: true });
    const seen = { outcome: 'none' as 'contact' | 'otp' | 'none' };
    await clickUntil(ctx, I.emailNext, async () => {
      if (await otp.count()) { seen.outcome = 'otp'; return true; }
      // Usually the contact page, but any move off the login page counts: the runner re-plans from wherever we land.
      if (!/\/checkout\/login/.test(ctx.page.url())) { seen.outcome = 'contact'; return true; }
      return false;
    }, { attempts: 3, waitMs: 6000 });
    if (seen.outcome === 'contact') noteReorder(ctx, 'login', /\/checkout\/contact-details/);
    const outcome = seen.outcome;
    if (outcome === 'otp') {
      await ctx.page.context().storageState({ path: ctx.log.path('session-state.json') });
      throw new Escalate('email OTP requested at checkout login: hand over to a human (session state saved)');
    }
    if (outcome === 'none') throw new Escalate('Next after email entry did nothing after 3 attempts');
  },
};

const contact: Step = {
  id: 'contact',
  when: on(/\/checkout\/contact-details/),
  run: async (ctx) => {
    const c = ctx.job.customer;
    await selectOption(ctx, I.salutation, c.title);
    await fillField(ctx, I.firstName, c.firstName);
    await fillField(ctx, I.lastName, c.lastName);
    await fillField(ctx, I.mobile, c.phone);
    // Masked input: type the digits one at a time; the mask adds the slashes.
    await fillField(ctx, I.dob, c.dateOfBirth.replace(/\D/g, ''), { typed: true, expect: c.dateOfBirth });
    await selectOption(ctx, I.hearAbout, 'Other', /other/i);
    await checkBox(ctx, I.privacy);
    await submitPage(ctx, 'contact', /\/checkout\/address-view/);
  },
};

/** The portal moved somewhere other than the usual next page: record an L3 re-plan; the runner picks the step for wherever we are. */
function noteReorder(ctx: RunContext, page: string, expected: RegExp) {
  if (expected.test(ctx.page.url())) return;
  const to = new URL(ctx.page.url()).pathname;
  ctx.healingEvents.push({
    intent: `${page}.next`, goal: 'continue the journey after this page', level: 'L3',
    broke: `step order changed: the page after ${page} was not the usual one`, changed: `portal went to ${to}; re-planned from page state`,
    trustedBecause: 'the runner selects the next step from the page it is on, and each step still checks its own postcondition',
    at: new Date().toISOString(),
  });
  ctx.log.warn(`HEAL L3 ${page}.next: step order changed (went to ${to}); re-planning from page state`);
}

/** Click Next and verify the page moved on; on validation errors, report them as the escalation reason. */
async function submitPage(ctx: RunContext, page: string, next: RegExp, intent: Intent = I.next(page), waitMs = 6000) {
  // The checkout form: the nearest container of the submit button holding several fields.
  await snap(ctx, page, ctx.page.getByRole('button', { name: /^\s*(next|process order.*)\s*$/i }).filter({ visible: true }), { minInputs: 2 });
  // Postcondition: the page moved on. Normally to `next`; anywhere else means the step order changed (L3 re-plan).
  const from = new URL(ctx.page.url()).pathname;
  const movedOn = () => poll(ctx, async () => next.test(ctx.page.url()) || new URL(ctx.page.url()).pathname !== from, 1000);
  const ok = await clickUntil(ctx, intent, movedOn, { attempts: 3, waitMs });
  if (ok) { noteReorder(ctx, page, next); return; }
  // L3: a required field the journey does not know about. Answer it from the payload, or escalate (L4).
  if ((await fillNewMandatoryFields(ctx, page)) > 0 && (await clickUntil(ctx, intent, movedOn, { attempts: 2, waitMs }))) {
    ctx.healingEvents.filter((h) => h.level === 'L3' && !h.trustedBecause).forEach((h) => { h.trustedBecause = 'the page accepted the submission and moved on'; });
    noteReorder(ctx, page, next);
    return;
  }
  const errors = await ctx.page.locator('.help-block, small[data-bv-validator], .invalid-feedback, .error-message').filter({ visible: true }).allInnerTexts();
  throw new Escalate(`could not leave the ${page} page${errors.length ? `; the portal says: ${errors.join(' | ')}` : ''}`);
}

const serviceAddress: Step = {
  id: 'serviceAddress',
  when: on(/\/checkout\/address-view/),
  run: async (ctx) => {
    // The structured address in the payload is the service address itself, so "Use Service Address" stays ticked.
    await checkBox(ctx, I.billingSelfCare);
    await submitPage(ctx, 'serviceAddress', /\/checkout\/transfer-number-view/, I.next('serviceAddress'));
  },
};

// ---------- Phase D: connection details ----------

const connection: Step = {
  id: 'connection',
  when: on(/\/checkout\/transfer-number-view/),
  run: async (ctx) => {
    const d = ctx.job.connectionDetails;
    const kind = ctx.job.normalised.activation;
    await checkBox(ctx, I.activation(kind));
    await clearPopups(ctx);
    if (kind === 'Transfer') {
      let avcOk = false;
      if (d.avcId) {
        await fillField(ctx, I.avcId, d.avcId);
        const check = await resolve(ctx, I.avcCheck);
        await check.locator.click();
        avcOk = await poll(ctx, async () => /valid|verified|success|found/i.test(await ctx.page.locator('#avc_id').locator('xpath=ancestor::div[2]').innerText()), 5000);
        if (!avcOk) ctx.warnings.push('AVC ID check failed within 5 s; chose Provide Later');
      }
      if (!avcOk) await checkBox(ctx, I.provideLater);
      await clearPopups(ctx);
      await selectOption(ctx, I.provider, d.currentProvider || 'Other', /other/i);
    }
    if (ctx.job.normalised.connectionDate) await fillField(ctx, I.connectionDate, ctx.job.normalised.connectionDate);
    if (await ctx.page.locator('input[name=sq24]').filter({ visible: true }).count()) await checkBox(ctx, I.nbnBoxUnsure);
    const r = ctx.job.normalised.router;
    if (r && !r.byo) {
      // (e) "wait for router delivery": only rendered when a router ships. Answer yes if present.
      const yes = ctx.page.getByText(/router/i).filter({ visible: true }).locator('xpath=following::input[@type="radio"][1]');
      if (await yes.count()) await yes.first().check({ force: true }).catch(() => ctx.warnings.push('router delivery question not answered'));
    }
    await clearPopups(ctx);
    await submitPage(ctx, 'connection', /\/checkout\/donate/, I.processOrder, 10_000);
  },
};

// ---------- Phase E/F: donation, payment, result ----------

const donation: Step = {
  id: 'donation',
  when: on(/\/checkout\/donate/),
  run: async (ctx) => {
    await checkBox(ctx, I.donateNo);
    await submitPage(ctx, 'donation', /\/checkout\/payment/, I.next('donation'));
  },
};

const payment: Step = {
  id: 'payment',
  when: async (ctx) => /\/checkout\/payment/.test(ctx.page.url()) && ctx.paymentState === 'not-started',
  run: async (ctx) => {
    ctx.guarded = true; // from here on: no model, no free-form healing, no screenshots, no ARIA dumps
    ctx.log.info('entering guarded payment phase; handing over to the payment executor');
    const res = await runPayment(ctx);
    ctx.log.info('payment executor result', res);
    if (!res.ok) {
      if (ctx.paymentState === 'declined') throw new Fail(res.maskedError || 'payment declined');
      // Scenario 16: no 3-D Secure and no transaction ID. Fail (the ledger already says unknown, so it is never retried).
      if (/^neither 3-D Secure nor a transaction ID/.test(res.maskedError || '')) throw new Fail(res.maskedError!);
      throw new Escalate(res.maskedError || 'payment executor stopped');
    }
    ctx.facts.last4 = res.last4;
  },
};

export const TXN_RE = /^\d{10}[a-z]{3}$/i; // the page renders it upper-case via CSS
const TXN_LOOSE = /^\d{9,11}[a-z0-9]{2,5}$/i;

async function readLabelled(page: Page, label: RegExp): Promise<string> {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const el = Array.from(document.querySelectorAll('body *')).find((e) => e.children.length === 0 && re.test((e.textContent || '').trim()));
    if (!el) return '';
    const own = (el.textContent || '').trim();
    let n: Element | null = el;
    for (let i = 0; n && i < 3; i++, n = n.parentElement) {
      const sib = n.nextElementSibling as HTMLElement | null;
      if (sib?.innerText?.trim()) return sib.innerText.trim().split(/\s+/)[0];
      const rest = (n as HTMLElement).innerText.replace(own, '').trim();
      if (rest) return rest.split(/\s+/)[0];
    }
    return '';
  }, label.source);
}

const confirmation: Step = {
  id: 'confirmation',
  terminal: true,
  when: async (ctx) => (await ctx.page.getByText(/your transaction id/i).filter({ visible: true }).count()) > 0,
  run: async (ctx) => {
    let id = '';
    await poll(ctx, async () => !!(id = await readLabelled(ctx.page, /^your transaction id$/)), 60_000);
    if (!id || !TXN_LOOSE.test(id)) throw new Fail(`no valid transaction ID on the confirmation page (read "${id}")`);
    if (!TXN_RE.test(id)) ctx.warnings.push(`transaction ID "${id}" does not match the expected format; accepted by the loose pattern`);
    ctx.facts.transactionId = id;
    ctx.facts.accountNumber = await readLabelled(ctx.page, /^your temporary account number$/).catch(() => '') || undefined;
    ctx.paymentState = 'completed';
    await ctx.page.screenshot({ path: ctx.log.path(`confirmation-${id}.png`), fullPage: true });
    ctx.log.info(`transaction ID ${id}`);
  },
};

// Order matters only as a tie-break; each step's `when` reads live state.
export const STEPS: Step[] = [confirmation, payment, donation, connection, serviceAddress, contact, login, address, plan, router, orderNow];
