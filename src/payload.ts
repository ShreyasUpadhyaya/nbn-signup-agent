// R1: validate and normalise the job payload. The payload never carries card data, only cardRef.
import { z } from 'zod';
import { createHash } from 'node:crypto';

const STREET_TYPES: Record<string, string> = {
  ST: 'STREET', RD: 'ROAD', AVE: 'AVENUE', AV: 'AVENUE', DR: 'DRIVE', CRES: 'CRESCENT', CR: 'CRESCENT',
  CT: 'COURT', PL: 'PLACE', HWY: 'HIGHWAY', PDE: 'PARADE', TCE: 'TERRACE', CL: 'CLOSE', LN: 'LANE',
  BVD: 'BOULEVARD', BLVD: 'BOULEVARD', CCT: 'CIRCUIT', GR: 'GROVE', WY: 'WAY', SQ: 'SQUARE', ESP: 'ESPLANADE',
  HTS: 'HEIGHTS', MWS: 'MEWS', RISE: 'RISE', LOOP: 'LOOP', WAY: 'WAY',
};

/** Uppercase, drop punctuation, expand abbreviated street types. Used to compare addresses and option labels. */
export function norm(s: string): string {
  return s
    .toUpperCase()
    .replace(/[®,.]/g, ' ')
    .replace(/-{2,}/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => STREET_TYPES[w] ?? w)
    .join(' ');
}

const ROUTER_TABS = [
  { match: /byo|bring your own/i, tab: 'Bring Your Own Router', option: 'BYO Modem' },
  { match: /eero/i, tab: 'Amazon eero 7', option: 'eero 7' },
  { match: /netcomm/i, tab: 'NetComm', option: 'NetComm' },
] as const;

const dob = z.string().transform((s, ctx) => {
  const m = s.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (!m) { ctx.addIssue({ code: 'custom', message: 'dateOfBirth must be DD/MM/YYYY' }); return z.NEVER; }
  return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
});

const PayloadSchema = z.object({
  jobId: z.string().min(1).optional(),
  portal: z.object({ url: z.url() }),
  customer: z.object({
    title: z.enum(['Mr', 'Mrs', 'Ms', 'Miss', 'Dr']),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    email: z.email(),
    phone: z.string().transform((s) => s.replace(/[\s-]/g, '').replace(/^\+?61/, '0')).pipe(z.string().regex(/^04\d{8}$/, 'phone must be an Australian mobile, e.g. 0412345678')),
    dateOfBirth: dob,
  }),
  connectionAddress: z.object({
    mainAddress: z.object({
      fullAddress: z.string().min(5),
      streetNumber: z.string().optional().default(''),
      streetName: z.string().optional().default(''),
      streetType: z.string().optional().default(''),
      suburb: z.string().optional().default(''),
      state: z.string().optional().default(''),
      postcode: z.string().optional().default(''),
      unitNumber: z.string().optional().default(''),
      country: z.string().optional().default('Australia'),
    }),
  }),
  plan: z.object({ name: z.string().min(1), speed: z.string().optional() }),
  addOns: z.object({
    router: z.object({ enabled: z.boolean(), model: z.string().optional().default('') }),
  }),
  connectionDetails: z.object({
    currentProvider: z.string().optional().default(''),
    avcId: z.string().optional().default(''),
    moveInDate: z.string().optional().default(''),
    movingProperty: z.boolean().optional().default(false),
  }),
  connectionDeliveryDate: z.string().optional().default('ASAP'),
  payment: z.object({
    method: z.literal('Credit Card'),
    cardRef: z.string().regex(/^vault:\/\/[\w/-]+$/, 'cardRef must be an opaque vault:// reference'),
    nameOnCard: z.string().min(1),
  }).strict(), // .strict(): a payload that smuggles pan/cvv/expiry is rejected outright
});

export type RawPayload = z.input<typeof PayloadSchema>;

export function parseJob(raw: unknown, source = '') {
  const p = PayloadSchema.parse(raw);
  const addr = p.connectionAddress.mainAddress;
  if (p.addOns.router.enabled && !p.addOns.router.model) throw new Error('addOns.router.model is required when the router is enabled');
  const router = p.addOns.router.enabled ? ROUTER_TABS.find((r) => r.match.test(p.addOns.router.model)) : undefined;
  if (p.addOns.router.enabled && !router) throw new Error(`Unknown router model "${p.addOns.router.model}" (expected BYO Modem, Amazon eero 7 or NetComm)`);

  // Stable id: the same payload maps to the same job, which is what makes the payment ledger idempotent.
  const jobId = p.jobId ?? `job-${createHash('sha256').update(JSON.stringify(raw)).digest('hex').slice(0, 12)}`;
  return {
    ...p,
    jobId,
    source,
    normalised: {
      fullAddress: norm(addr.fullAddress),
      streetType: addr.streetType ? norm(addr.streetType) : '',
      hasStructuredAddress: Boolean(addr.streetNumber && addr.streetName && addr.suburb && addr.postcode),
      router: router ? { tab: router.tab, option: router.option, byo: router.tab === 'Bring Your Own Router' } : undefined,
      activation: p.connectionDetails.moveInDate ? 'New' as const : 'Transfer' as const,
      connectionDate: /^asap$/i.test(p.connectionDeliveryDate.trim()) ? '' : p.connectionDeliveryDate.trim(),
    },
  };
}

export type Job = ReturnType<typeof parseJob>;

/** Payload paths the model may reference when a field needs a value (rule: values come from the payload only). */
export const VALUE_REFS = [
  'customer.title', 'customer.firstName', 'customer.lastName', 'customer.email', 'customer.phone', 'customer.dateOfBirth',
  'connectionAddress.mainAddress.fullAddress', 'connectionAddress.mainAddress.streetNumber', 'connectionAddress.mainAddress.streetName',
  'connectionAddress.mainAddress.streetType', 'connectionAddress.mainAddress.suburb', 'connectionAddress.mainAddress.state',
  'connectionAddress.mainAddress.postcode', 'connectionAddress.mainAddress.unitNumber',
  'connectionDetails.currentProvider', 'connectionDetails.avcId', 'connectionDeliveryDate', 'payment.nameOnCard',
] as const;

export function valueAt(job: Job, ref: string): string | undefined {
  if (!(VALUE_REFS as readonly string[]).includes(ref)) return undefined;
  const v = ref.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], job);
  return typeof v === 'string' ? v : undefined;
}
