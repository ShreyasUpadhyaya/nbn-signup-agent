import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { redact } from './security/redact.js';

export class RunLog {
  readonly dir: string;
  private readonly file: string;

  constructor(runsRoot: string, jobId: string) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.resolve(runsRoot, `${jobId}-${stamp}`);
    mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, 'run.log');
  }

  info(msg: string, data?: unknown) { this.write('INFO', msg, data); }
  warn(msg: string, data?: unknown) { this.write('WARN', msg, data); }
  error(msg: string, data?: unknown) { this.write('ERROR', msg, data); }

  private write(level: string, msg: string, data?: unknown) {
    const line = redact(`${new Date().toISOString()} ${level} ${msg}${data === undefined ? '' : ' ' + JSON.stringify(data)}`);
    appendFileSync(this.file, line + '\n');
    console.log(level === 'INFO' ? line.slice(25) : `\x1b[${level === 'WARN' ? 33 : 31}m${line.slice(25)}\x1b[0m`);
  }

  /** Writes a JSON artifact into the run folder, always redacted. */
  json(name: string, data: unknown) {
    writeFileSync(path.join(this.dir, name), redact(JSON.stringify(data, null, 2)));
  }

  appendJsonl(name: string, data: unknown) {
    appendFileSync(path.join(this.dir, name), redact(JSON.stringify(data)) + '\n');
  }

  path(name: string) { return path.join(this.dir, name); }
}
