// Vault stub. Only the payment executor imports this module; the planner and model never can.
// The vault file lives outside the repo (VAULT_PATH, default ~/.nbn-agent/vault.json).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface CardSecret { pan: string; cvv: string; expiry: string }

export const vaultPath = () => process.env.VAULT_PATH || path.join(os.homedir(), '.nbn-agent', 'vault.json');

/** resolve(cardRef, jobId): returns the card for this one job and writes an audit line without any card values. */
export function resolve(cardRef: string, jobId: string, caller: string): CardSecret {
  const file = vaultPath();
  const audit = (outcome: string) => {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(path.join(path.dirname(file), 'vault-audit.log'),
      JSON.stringify({ time: new Date().toISOString(), jobId, cardRef, caller, outcome }) + '\n');
  };
  const key = cardRef.replace(/^vault:\/\//, '');
  if (!existsSync(file)) { audit('vault-missing'); throw new Error('card reference could not be resolved'); }
  const entry = (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<CardSecret>>)[key];
  if (!entry?.pan || !entry.cvv || !entry.expiry) { audit('not-found'); throw new Error('card reference could not be resolved'); }
  audit('resolved');
  return { pan: entry.pan, cvv: entry.cvv, expiry: entry.expiry };
}

/** Best effort: overwrite our references. JS strings are immutable, so this limits lifetime but cannot zero memory. */
export function wipe(card: CardSecret) {
  card.pan = ''; card.cvv = ''; card.expiry = '';
}
