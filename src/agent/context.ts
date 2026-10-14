import type { Page } from 'playwright';
import type { Job } from '../payload.js';
import type { RunLog } from '../log.js';
import type { HealEvent } from '../browser/resolver.js';

export type Status = 'success' | 'escalated' | 'failed';
export type PaymentState = 'not-started' | 'submitting' | 'unknown' | 'completed' | 'declined';

export interface Budgets {
  maxSteps: number;
  maxRetriesPerStep: number;
  timeLimitMs: number;
  maxModelCalls: number;
  maxHeals: number;
  /** How long the address check may take before the shop flow is reloaded. */
  addressResultMs: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  maxSteps: 40,
  maxRetriesPerStep: 3,
  timeLimitMs: 10 * 60_000, // the legacy script used 6 min; this portal's address check alone takes ~17 s
  maxModelCalls: 6,
  maxHeals: 10,
  addressResultMs: 60_000,
};

export interface RunContext {
  page: Page;
  job: Job;
  log: RunLog;
  budgets: Budgets;
  startedAt: number;
  useModel: boolean;
  /** Stop at the payment page before the card is ever resolved. */
  dryRun: boolean;
  /** True from the payment page onwards: no model calls, no free-form healing, no screenshots. */
  guarded: boolean;
  modelCalls: number;
  completedSteps: string[];
  healingEvents: HealEvent[];
  warnings: string[];
  paymentState: PaymentState;
  facts: {
    addressConfirmed?: boolean;
    cartTotal?: string;
    transactionId?: string;
    accountNumber?: string;
    last4?: string;
  };
}

/** Thrown to stop the run and hand over to a human with evidence. */
export class Escalate extends Error {
  constructor(public readonly reason: string, public readonly suggestedPatch?: unknown) { super(reason); this.name = 'Escalate'; }
}

/** Thrown when the run must stop as failed (the outcome is known to be wrong, not merely uncertain). */
export class Fail extends Error {
  constructor(public readonly reason: string) { super(reason); this.name = 'Fail'; }
}

export function checkTime(ctx: RunContext) {
  if (Date.now() - ctx.startedAt > ctx.budgets.timeLimitMs) throw new Escalate(`time budget of ${ctx.budgets.timeLimitMs / 1000}s spent`);
}
