// Everything that leaves the process (console, run.log, report, model-call log) goes through redact().

/** Luhn check, so we mask real-looking card numbers but leave order IDs and phone numbers alone. */
export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

const PAN_LIKE = /\b(?:\d[ -]?){12,18}\d\b/g;
const CVV_CONTEXT = /\b(cvv|cvc|cvn|security code)(["'\s:=]{0,6})\d{3,4}\b/gi;

export function redact(text: string): string {
  return text
    .replace(PAN_LIKE, (m) => (luhn(m.replace(/\D/g, '')) ? '[REDACTED-PAN]' : m))
    .replace(CVV_CONTEXT, '$1$2[REDACTED]')
    .replace(/\bsk-[\w*-]{8,}/g, '[REDACTED-KEY]')
    .replace(/\bAIza[\w-]{20,}/g, '[REDACTED-KEY]');
}

/** Error text from inside the payment executor never leaves it; callers only ever see this masked form. */
export function maskedError(stage: string, e: unknown): string {
  const name = e instanceof Error ? e.name : 'Error';
  return `payment executor failed at "${stage}" (${name})`;
}
