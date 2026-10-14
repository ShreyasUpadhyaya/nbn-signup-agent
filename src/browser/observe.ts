// What the model is allowed to see: a pruned list of visible interactive elements.
// Never input values, never anything inside a payment container or a cross-origin frame.
import type { Locator, Page } from 'playwright';
import type { RunContext } from '../agent/context.js';
import { redact } from '../security/redact.js';

export interface ObservedElement {
  idx: number;
  role: string;
  name: string;
  text: string;
  id: string;
  context: string;
  inDialog: boolean;
  payment: boolean;
}

/** Page text that tries to instruct the agent. It is data, never an instruction: logged and dropped. */
export const INJECTION = /ignore (all |any )?(previous|prior|your|the above) instructions|system prompt|you are an? (ai|assistant|agent)|as an ai|send (the )?card|card (number|details) (to|into)|disregard .{0,30}instructions/i;

export async function observeElements(ctx: RunContext, root: Page | Locator): Promise<ObservedElement[]> {
  const container = 'goto' in root ? root.locator('body') : root;
  const raw = await container.evaluate((rootEl) => {
    const SEL = 'a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=tab],[role=radio],[role=checkbox],[role=option],[onclick]';
    const PAYMENT = '#number_div,#cvv_div,[id*=card i],[name*=card i],[id*=cvv i],[id*=expiry i],[id*=expriy i]';
    const roleOf = (e: Element): string => {
      const r = e.getAttribute('role'); if (r) return r;
      const t = e.tagName.toLowerCase(); const type = (e.getAttribute('type') || '').toLowerCase();
      if (t === 'a') return 'link';
      if (t === 'button' || (t === 'input' && ['submit', 'button'].includes(type))) return 'button';
      if (t === 'select') return 'combobox';
      if (t === 'textarea') return 'textbox';
      if (t === 'input') return type === 'checkbox' ? 'checkbox' : type === 'radio' ? 'radio' : type === 'search' ? 'searchbox' : 'textbox';
      return 'generic';
    };
    const nameOf = (e: Element): string => {
      const aria = e.getAttribute('aria-label'); if (aria) return aria;
      const id = e.id; const lbl = id ? rootEl.ownerDocument.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      if (lbl) return (lbl as HTMLElement).innerText;
      const wrap = e.closest('label'); if (wrap) return wrap.innerText;
      if (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement) return e.placeholder || e.name || '';
      return (e as HTMLElement).innerText || e.getAttribute('title') || '';
    };
    const contextOf = (e: Element): string => {
      let p: Element | null = e.parentElement;
      for (let i = 0; p && i < 8; i++, p = p.parentElement) {
        // Only visible headings: the portal keeps ~30 hidden popups (with headings) in the DOM.
        const h = Array.from(p.querySelectorAll('h1,h2,h3,h4,h5,[role=heading]')).find((x) => (x as HTMLElement).offsetParent && (x as HTMLElement).innerText.trim());
        if (h) return (h as HTMLElement).innerText;
      }
      return '';
    };
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 80);
    const out: Array<Record<string, unknown>> = [];
    let idx = 0;
    for (const e of Array.from(rootEl.querySelectorAll(SEL))) {
      const he = e as HTMLElement;
      if (!he.offsetParent && getComputedStyle(he).position !== 'fixed') continue;
      const r = he.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue;
      he.setAttribute('data-agent-idx', String(idx));
      out.push({
        idx, role: roleOf(e), name: clean(nameOf(e)), text: clean(he.innerText || ''), id: e.id || '',
        context: clean(contextOf(e)), inDialog: !!e.closest('[role=dialog]'), payment: !!e.closest(PAYMENT) || e.matches(PAYMENT),
      });
      idx++;
      if (idx >= 200) break;
    }
    return out;
  });
  const els = raw as unknown as ObservedElement[];
  const safe: ObservedElement[] = [];
  for (const e of els) {
    if (INJECTION.test(`${e.name} ${e.text} ${e.context}`)) {
      ctx.warnings.push(`prompt-injection text ignored on ${ctx.page.url()}`);
      ctx.log.warn('page text that tries to instruct the agent was dropped from the model view', { idx: e.idx, text: e.name.slice(0, 60) });
      continue;
    }
    if (e.payment) continue;
    safe.push({ ...e, name: redact(e.name), text: redact(e.text), context: redact(e.context) });
  }
  return safe;
}

/** Scan the whole page (including hidden text) for injection attempts, so they are reported even if never shown to the model. */
export async function scanForInjection(ctx: RunContext) {
  const text = await ctx.page.locator('body').evaluate((b) => b.textContent || '').catch(() => '');
  const m = text.match(INJECTION);
  if (m) {
    const where = new URL(ctx.page.url()).pathname;
    const note = `prompt-injection text found on ${where} ("${m[0]}"); treated as data and ignored`;
    if (!ctx.warnings.includes(note)) { ctx.warnings.push(note); ctx.log.warn(note); }
  }
}
