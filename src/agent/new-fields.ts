// L3 for "new mandatory field": the page refused to submit because of a required field the journey does not know.
// The value must come from the payload (VALUE_REFS). A deterministic label table is tried first; the model may only
// pick a payload field NAME from the allow-list, never a value. Checkboxes and radios (consents, choices) are never
// answered: inventing consent is not the agent's call, so those escalate (L4).
import { Escalate, type RunContext } from './context.js';
import { VALUE_REFS, valueAt } from '../payload.js';
import { chooseValueRef } from '../llm/ground.js';

interface Missing { idx: number; label: string; kind: 'text' | 'select' | 'checkbox' | 'radio' }

const LABEL_TO_REF: Array<[RegExp, string]> = [
  [/e-?mail/i, 'customer.email'],
  [/mobile|phone/i, 'customer.phone'],
  [/first name|given name/i, 'customer.firstName'],
  [/last name|surname|family name/i, 'customer.lastName'],
  [/date of birth|\bdob\b|birth date/i, 'customer.dateOfBirth'],
  [/post ?code/i, 'connectionAddress.mainAddress.postcode'],
  [/suburb|town/i, 'connectionAddress.mainAddress.suburb'],
  [/street number/i, 'connectionAddress.mainAddress.streetNumber'],
  [/street name/i, 'connectionAddress.mainAddress.streetName'],
  [/\bstate\b/i, 'connectionAddress.mainAddress.state'],
  [/provider/i, 'connectionDetails.currentProvider'],
  [/\bavc\b/i, 'connectionDetails.avcId'],
];

/** Visible required controls that are still empty, tagged so they can be located again. */
async function findMissing(ctx: RunContext): Promise<Missing[]> {
  return ctx.page.evaluate(() => {
    const out: Array<{ idx: number; label: string; kind: 'text' | 'select' | 'checkbox' | 'radio' }> = [];
    const labelOf = (e: HTMLElement) => {
      const byFor = e.id ? document.querySelector(`label[for="${CSS.escape(e.id)}"]`) : null;
      return ((byFor || e.closest('label'))?.textContent || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('name') || '')
        .replace(/\s+/g, ' ').trim();
    };
    const seenRadio = new Set<string>();
    let i = 0;
    for (const e of Array.from(document.querySelectorAll<HTMLInputElement>('input:not([type=hidden]),select,textarea'))) {
      if (!e.offsetParent || e.disabled) continue;
      const label = labelOf(e);
      const required = e.required || e.getAttribute('aria-required') === 'true' || /\*\s*$/.test(label);
      if (!required) continue;
      const type = (e.getAttribute('type') || '').toLowerCase();
      let kind: 'text' | 'select' | 'checkbox' | 'radio' = e.tagName === 'SELECT' ? 'select' : 'text';
      let empty = !e.value.trim();
      if (type === 'checkbox') { kind = 'checkbox'; empty = !e.checked; }
      if (type === 'radio') {
        if (seenRadio.has(e.name)) continue;
        seenRadio.add(e.name);
        kind = 'radio';
        empty = !document.querySelector(`input[type=radio][name="${CSS.escape(e.name)}"]:checked`);
      }
      if (!empty) continue;
      e.setAttribute('data-agent-req', String(i));
      out.push({ idx: i++, label: label.replace(/\*\s*$/, '').trim(), kind });
    }
    return out;
  });
}

/**
 * Try to satisfy new required fields from the payload. Returns the number filled (0 if nothing was missing).
 * Throws Escalate when a field cannot be answered from the payload.
 */
export async function fillNewMandatoryFields(ctx: RunContext, page: string): Promise<number> {
  const missing = await findMissing(ctx);
  let filled = 0;
  for (const m of missing) {
    if (m.kind === 'checkbox' || m.kind === 'radio') {
      throw new Escalate(`new mandatory ${m.kind} "${m.label}" on the ${page} page: a consent or choice is never invented; a human must decide`);
    }
    let ref = LABEL_TO_REF.find(([re]) => re.test(m.label))?.[1];
    let how = 'label table';
    if (!ref && ctx.useModel && !ctx.guarded) {
      ref = await chooseValueRef(ctx, m.label, page);
      how = 'model (payload field name only)';
    }
    const value = ref ? valueAt(ctx.job, ref) : undefined;
    if (!ref || !(VALUE_REFS as readonly string[]).includes(ref) || !value) {
      throw new Escalate(`new mandatory field "${m.label}" on the ${page} page cannot be answered from the payload`);
    }
    const el = ctx.page.locator(`[data-agent-req="${m.idx}"]`);
    if (m.kind === 'select') await el.selectOption({ label: value }).catch(() => el.selectOption(value));
    else await el.fill(value);
    const back = m.kind === 'select' ? await el.evaluate((s) => (s as HTMLSelectElement).selectedOptions[0]?.textContent?.trim() || '') : await el.inputValue();
    if (back.trim().toLowerCase() !== value.trim().toLowerCase()) throw new Escalate(`new mandatory field "${m.label}" did not keep the payload value`);
    if (ctx.healingEvents.length >= ctx.budgets.maxHeals) throw new Escalate('heal budget spent');
    ctx.healingEvents.push({
      intent: `${page}.newField`, goal: `fill the new mandatory field "${m.label}"`, level: 'L3',
      broke: `required field "${m.label}" blocked the ${page} page`, changed: `filled from payload ${ref} (chosen by ${how})`,
      at: new Date().toISOString(),
    });
    ctx.log.warn(`HEAL L3 ${page}.newField: required field "${m.label}" -> filled from payload ${ref} (${how})`);
    filled++;
  }
  return filled;
}
