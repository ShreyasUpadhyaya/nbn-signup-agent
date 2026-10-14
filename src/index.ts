// Single command: run one job from a payload file and print the JSON result.
//   npm run job -- payloads/sample-job.json [--mutate] [--headless] [--no-model]
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { parseJob } from './payload.js';
import { runJob } from './agent/runner.js';

import { newJob } from '../scripts/new-job.js';

const args = process.argv.slice(2);
// --fresh: copy the given (or sample) payload with a new throwaway email and jobId, then run that.
const given = args.find((a) => !a.startsWith('--')) || (args.includes('--fresh') ? 'payloads/sample-job.json' : process.env.JOB_PAYLOAD);
const file = given && args.includes('--fresh') ? newJob(given) : given;
if (!file) {
  console.error('usage: npm run job -- <payload.json> [--fresh] [--mutate] [--headless] [--no-model] [--dry-run]');
  process.exit(2);
}

let job;
try {
  job = parseJob(JSON.parse(readFileSync(file, 'utf8')), file);
} catch (e) {
  // Validation messages name fields, never values.
  console.error(`invalid payload ${file}:`, e instanceof Error ? e.message : e);
  process.exit(2);
}

const report = await runJob(job, {
  mutate: args.includes('--mutate'),
  headless: args.includes('--headless'),
  useModel: !args.includes('--no-model'),
  dryRun: args.includes('--dry-run'),
});

console.log('\n' + JSON.stringify(report, null, 2));
process.exit(report.status === 'success' ? 0 : report.status === 'escalated' ? 3 : 1);
