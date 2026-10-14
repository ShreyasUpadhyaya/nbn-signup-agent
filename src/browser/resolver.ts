// The healing ladder for "find the element for this intent".
//   primary locator  ->  L0 re-observe (wait, clear popups, retry)  ->  L1 heal memory / fallback locators
//   ->  L2 semantic re-grounding by the model, checked by a deterministic validator.
// A heal is only *proposed* here. It is committed (logged + saved to heal memory) by the step,
// after the step's independent postcondition passes.
import type { Locator, Page } from 'playwright';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Escalate, checkTime, type RunContext } from '../agent/context.js';
import { observeElements, type ObservedElement } from './observe.js';
import { groundWithModel } from '../llm/ground.js';

type AriaRole = Parameters<Page['getByRole']>[0];

export type LocatorSpec =
  | { by: 'role'; role: AriaRole; name: string; exact?: boolean }
  | { by: 'label'; text: string }
  | { by: 'text'; text: string; exact?: boolean }
  | { by: 'css'; selector: string };

export interface Intent {
  /** Stable key, also the heal-memory key, e.g. "plan.choose[Value Plus]". */
  key: string;
  /** Plain-English purpose. This is what the model is told; never any payload values. */
  goal: string;
  kind: 'click' | 'fill' | 'select' | 'check';
  /** candidates[0] is the primary locator; the rest are the L1 fallbacks in order. */
  candidates: LocatorSpec[];
  /** Search only inside this container (e.g. the visible dialog). */
  within?: LocatorSpec;
  /** Guarded intents never reach L2: payment fields, Pay Now, OTP, CAPTCHA. */
  guarded?: boolean;
  /** Element names the model may never choose for this intent. */
  deny?: RegExp;
}

export interface HealEvent {
  intent: string;
  goal: string;
  level: 'L0' | 'L1' | 'L1-memory' | 'L2' | 'L3';
  broke: string;
  changed: string;
  newLocator?: LocatorSpec;
  trustedBecause?: string;
  confidence?: number;
  at: string;
}

export interface Resolved {
  locator: Locator;
  spec: LocatorSpec;
  heal?: HealEvent;
}

export const describe = (s: LocatorSpec): string =>
  s.by === 'role' ? `role=${s.role}[name${s.exact ? '=' : '~'}"${s.name}"]`
    : s.by === 'label' ? `label="${s.text}"`
      : s.by === 'text' ? `text${s.exact ? '=' : '~'}"${s.text}"`
        : `css=${s.selector}`;

export function build(root: Page | Locator, s: LocatorSpec): Locator {
  const l = s.by === 'role' ? root.getByRole(s.role, { name: s.name, exact: s.exact ?? false })
    : s.by === 'label' ? root.getByLabel(s.text)
      : s.by === 'text' ? root.getByText(s.text, { exact: s.exact ?? false })
        : root.locator(s.selector);
  // The portal keeps ~30 hidden popups in the DOM; only visible elements are ever candidates.
  return l.filter({ visible: true });
}

// ---------- heal memory ----------

interface MemoryRecord {
  goal: string;
  locator: LocatorSpec;
  level: HealEvent['level'];
  evidence: string;
  confidence: number;
  date: string;
  /** A human sets this to "rejected" in review; rejected records are never reused. */
  status: 'proposed' | 'approved' | 'rejected';
}

const memoryFile = () => path.resolve('heal-memory', `${process.env.RETAILER || 'tangerine'}.json`);

function loadMemory(): Record<string, MemoryRecord> {
  return existsSync(memoryFile()) ? JSON.parse(readFileSync(memoryFile(), 'utf8')) : {};
}

function saveMemory(key: string, rec: MemoryRecord) {
  const all = loadMemory();
  all[key] = rec;
  mkdirSync(path.dirname(memoryFile()), { recursive: true });
  // Sorted keys keep the file diff-friendly for review.
  writeFileSync(memoryFile(), JSON.stringify(Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b))), null, 2) + '\n');
}

// ---------- resolve ----------

type PopupClearer = (ctx: RunContext) => Promise<void>;
let clearPopups: PopupClearer = async () => {};
export const setPopupClearer = (fn: PopupClearer) => { clearPopups = fn; };

async function firstMatch(root: Page | Locator, spec: LocatorSpec): Promise<Locator | undefined> {
  const loc = build(root, spec);
  return (await loc.count().catch(() => 0)) > 0 ? loc.first() : undefined;
}

async function scopeRoot(ctx: RunContext, intent: Intent): Promise<Page | Locator | undefined> {
  if (!intent.within) return ctx.page;
  return firstMatch(ctx.page, intent.within);
}

export async function resolve(ctx: RunContext, intent: Intent, opts: { timeoutMs?: number } = {}): Promise<Resolved> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const memory = loadMemory()[intent.key];
  const remembered = memory && memory.status !== 'rejected' ? memory.locator : undefined;
  const [primary, ...fallbacks] = intent.candidates;
  const deadline = Date.now() + timeoutMs;

  for (let round = 0; ; round++) {
    checkTime(ctx);
    const root = await scopeRoot(ctx, intent);
    if (root) {
      const hit = await firstMatch(root, primary);
      // Waiting for a slow element is normal operation, not a heal; it is not reported as one.
      if (hit) return { locator: hit, spec: primary };
      if (remembered) {
        const m = await firstMatch(root, remembered);
        if (m) return { locator: m, spec: remembered, heal: { ...event(intent, 'L1-memory', `primary ${describe(primary)} matched nothing`, `reused healed locator ${describe(remembered)} from heal memory`), newLocator: remembered } };
      }
      for (const fb of fallbacks) {
        const m = await firstMatch(root, fb);
        if (m) return { locator: m, spec: fb, heal: { ...event(intent, 'L1', `primary ${describe(primary)} matched nothing`, `fallback ${describe(fb)}`), newLocator: fb } };
      }
    }
    if (Date.now() > deadline) break;
    // L0: re-observe. Clear any benign popup, give the reactive page a moment, look again.
    await clearPopups(ctx);
    await ctx.page.waitForTimeout(Math.min(500 + round * 250, 1500));
  }

  // L2: ask the model where the element is. Never for guarded intents or guarded pages.
  if (intent.guarded || ctx.guarded) {
    throw new Escalate(`guarded element "${intent.goal}" not found; guarded steps are never healed by the model`, { intent: intent.key, tried: intent.candidates.map(describe) });
  }
  if (!ctx.useModel) {
    throw new Escalate(`could not find "${intent.goal}" (model healing disabled)`, { intent: intent.key, tried: intent.candidates.map(describe) });
  }
  return groundL2(ctx, intent);
}

async function groundL2(ctx: RunContext, intent: Intent): Promise<Resolved> {
  const tried = intent.candidates.map(describe);
  const root = (await scopeRoot(ctx, intent)) ?? ctx.page;
  const elements = await observeElements(ctx, root);
  const answer = await groundWithModel(ctx, intent, elements);
  const el = validate(intent, elements, answer);
  if (!el) {
    throw new Escalate(`model could not re-ground "${intent.goal}"`, { intent: intent.key, tried, modelAnswer: answer });
  }
  const spec = await durableSpec(ctx.page, el);
  const locator = build(ctx.page, spec).first();
  ctx.log.info(`L2 proposal for ${intent.key}: #${el.idx} ${el.role} "${el.name}" -> ${describe(spec)} (confidence ${answer.confidence})`);
  return {
    locator, spec,
    heal: {
      ...event(intent, 'L2', `no locator matched (${tried.join(', ')})`, `model chose ${el.role} "${el.name}"${el.context ? ` under "${el.context}"` : ''}: ${answer.reason}`),
      newLocator: spec, confidence: answer.confidence,
    },
  };
}

/** Deterministic checks on the model's proposal before anything runs. */
function validate(intent: Intent, elements: ObservedElement[], a: { index: number; confidence: number }): ObservedElement | undefined {
  const el = elements.find((e) => e.idx === a.index);
  if (!el || a.confidence < 0.5) return undefined;
  const fits = {
    click: () => true,
    fill: () => el.role === 'textbox' || el.role === 'searchbox' || el.role === 'spinbutton',
    select: () => el.role === 'combobox' || el.role === 'listbox',
    check: () => el.role === 'checkbox' || el.role === 'radio',
  }[intent.kind]();
  if (!fits) return undefined;
  if (intent.deny?.test(`${el.name} ${el.context}`)) return undefined;
  if (el.payment) return undefined;
  return el;
}

/** Turn the model's chosen element into a locator that will still work on the next run. */
async function durableSpec(page: Page, el: ObservedElement): Promise<LocatorSpec> {
  const options: LocatorSpec[] = [];
  if (el.id && !/\d{4,}|[A-Za-z0-9]{7,}-?[A-Za-z0-9]{6,}/.test(el.id)) options.push({ by: 'css', selector: `[id="${el.id}"]` });
  if (el.name && el.role !== 'generic') options.push({ by: 'role', role: el.role as AriaRole, name: el.name, exact: true });
  if (el.text) options.push({ by: 'text', text: el.text, exact: true });
  for (const spec of options) {
    const loc = build(page, spec);
    if ((await loc.count()) !== 1) continue;
    const same = await loc.evaluate((n, idx) => n.getAttribute('data-agent-idx') === String(idx), el.idx).catch(() => false);
    if (same) return spec;
  }
  return { by: 'css', selector: `[data-agent-idx="${el.idx}"]` };
}

function event(intent: Intent, level: HealEvent['level'], broke: string, changed: string): HealEvent {
  return { intent: intent.key, goal: intent.goal, level, broke, changed, at: new Date().toISOString() };
}

/** Called by a step after its postcondition passed: the heal becomes a reported event and a memory record. */
export function commitHeal(ctx: RunContext, r: Resolved, trustedBecause: string) {
  if (!r.heal) return;
  if (ctx.healingEvents.length >= ctx.budgets.maxHeals) throw new Escalate('heal budget spent');
  const heal = { ...r.heal, trustedBecause };
  ctx.healingEvents.push(heal);
  ctx.log.warn(`HEAL ${heal.level} ${heal.intent}: ${heal.broke} -> ${heal.changed}; trusted because ${trustedBecause}`);
  const unstable = heal.newLocator?.by === 'css' && heal.newLocator.selector.includes('data-agent-idx');
  if (heal.newLocator && heal.level !== 'L1-memory' && !unstable) {
    saveMemory(heal.intent, {
      goal: heal.goal, locator: heal.newLocator, level: heal.level, evidence: `${heal.broke}; ${trustedBecause}`,
      confidence: heal.confidence ?? 0.9, date: heal.at, status: 'proposed',
    });
  }
}

export function rejectHeal(ctx: RunContext, r: Resolved, why: string) {
  if (r.heal) ctx.log.warn(`heal REJECTED for ${r.heal.intent} (${r.heal.changed}): ${why}`);
}
