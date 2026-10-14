// Automated leak check: scans every run artifact (logs, reports, model-call logs, heal memory, screenshots'
// metadata) for the test card number and CVV. Exits non-zero if either is found.
//   npm run leak-check                 scan runs/ and heal-memory/
//   npm run leak-check -- <dir> ...    scan specific paths
//   npm run leak-check -- --self-test  prove the scanner catches a planted PAN
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { luhn } from './redact.js';
import { vaultPath } from '../payment/vault.js';

interface Finding { file: string; kind: string; sample: string }

/** Secrets to look for: every card in the vault stub (if readable), plus the public test card from the handout. */
function secrets(): { pans: string[]; cvvs: string[] } {
  const pans = new Set<string>(['4111111111111111']);
  const cvvs = new Set<string>();
  try {
    const v = JSON.parse(readFileSync(vaultPath(), 'utf8')) as Record<string, { pan?: string; cvv?: string }>;
    for (const c of Object.values(v)) { if (c.pan) pans.add(c.pan.replace(/\D/g, '')); if (c.cvv) cvvs.add(c.cvv); }
  } catch { /* no vault on this machine: scan for the handout test card and any Luhn-valid number */ }
  if (!cvvs.size) cvvs.add('123');
  return { pans: [...pans], cvvs: [...cvvs] };
}

function* files(p: string): Generator<string> {
  if (!existsSync(p)) return;
  if (statSync(p).isFile()) { yield p; return; }
  for (const e of readdirSync(p)) yield* files(path.join(p, e));
}

export function scan(paths: string[]): Finding[] {
  const { pans, cvvs } = secrets();
  const findings: Finding[] = [];
  for (const root of paths) {
    for (const f of files(root)) {
      // Binary files (PNG) are scanned too: a card number in image metadata or a text chunk still counts.
      const text = readFileSync(f).toString('latin1');
      const digitsOnly = text.replace(/[ \-]/g, '');
      for (const pan of pans) {
        if (digitsOnly.includes(pan)) findings.push({ file: f, kind: 'test PAN', sample: `…${pan.slice(-4)}` });
      }
      for (const m of text.matchAll(/\b(?:\d[ -]?){12,18}\d\b/g)) {
        const d = m[0].replace(/\D/g, '');
        if (luhn(d) && !pans.includes(d) && /^[3-6]/.test(d)) findings.push({ file: f, kind: 'Luhn-valid card-like number', sample: `…${d.slice(-4)}` });
      }
      for (const cvv of cvvs) {
        const re = new RegExp(`(cvv|cvc|cvn|security.?code)[^\\n]{0,20}\\b${cvv}\\b`, 'i');
        if (re.test(text)) findings.push({ file: f, kind: 'CVV next to a CVV label', sample: '***' });
      }
    }
  }
  return findings;
}

function selfTest(): boolean {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'leak-selftest-'));
  try {
    writeFileSync(path.join(dir, 'clean.log'), 'order 1791996082tco phone 0412345678 total $59.90\n');
    writeFileSync(path.join(dir, 'leaky.log'), 'typed card 4111 1111 1111 1111 and "cvv": "123"\n');
    const found = scan([dir]);
    const ok = found.some((f) => f.file.endsWith('leaky.log') && f.kind === 'test PAN')
      && found.some((f) => f.file.endsWith('leaky.log') && f.kind.startsWith('CVV'))
      && !found.some((f) => f.file.endsWith('clean.log'));
    console.log(ok ? 'self-test passed: planted PAN and CVV were caught, clean file was not flagged' : 'SELF-TEST FAILED');
    return ok;
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) process.exit(selfTest() ? 0 : 1);
  const targets = args.length ? args : ['runs', 'heal-memory'];
  const findings = scan(targets);
  const scanned = targets.reduce((n, t) => n + [...files(t)].length, 0);
  if (findings.length) {
    console.error(`LEAK CHECK FAILED: ${findings.length} finding(s) in ${scanned} file(s)`);
    for (const f of findings) console.error(`  ${f.kind}: ${f.file} (${f.sample})`);
    process.exit(1);
  }
  console.log(`leak check passed: ${scanned} file(s) in ${targets.join(', ')} contain no card number or CVV`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
