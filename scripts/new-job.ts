// Creates a fresh job payload from the sample with a new throwaway yopmail address and jobId.
// Repeated runs with the same email trigger an email OTP on this portal, and the payment ledger
// refuses to pay twice for the same jobId, so each demo run needs its own payload.
//   npm run new-job                  -> payloads/generated/job-<stamp>.json
//   npm run new-job -- --email x@yopmail.com
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function newJob(base = 'payloads/sample-job.json', email?: string): string {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(4, 14); // MMDDhhmmss
  const job = JSON.parse(readFileSync(base, 'utf8'));
  job.jobId = `job-${stamp}`;
  job.customer.email = email ?? `nbnagent-${stamp}@yopmail.com`;
  mkdirSync('payloads/generated', { recursive: true });
  const out = path.join('payloads', 'generated', `job-${stamp}.json`);
  writeFileSync(out, JSON.stringify(job, null, 2) + '\n');
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--email');
  console.log(newJob('payloads/sample-job.json', i >= 0 ? args[i + 1] : undefined));
}
