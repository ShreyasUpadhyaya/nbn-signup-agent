# Design note: NBN sign-up agent

## Architecture

```
payload.json ─▶ parseJob (Zod, R1) ─▶ runner: observe ▸ decide ▸ act ▸ verify ─▶ report.json
                                            │                     │
                         steps.ts (goals + postconditions)    resolver.ts (healing ladder)
                                            │                     └─ L2: ground.ts ─▶ OpenAI (element index only)
                                            └─ payment step ─▶ executor.ts ─▶ vault.ts (cardRef → card, audited)
```

TypeScript, Playwright and Zod, plus one model call type through the OpenAI SDK. It runs on Gemini
(`gemini-3.5-flash-lite`, via Gemini's OpenAI-compatible endpoint) or on OpenAI, set by `MODEL_PROVIDER`. I didn't use an agent framework. The loop is about 150 lines,
so every decision it makes can be explained and tested.

## Agent loop (R3)

The journey is a set of **goals, not a fixed list**. Each step declares `when` (detected from the URL and live page state)
and a `run` that ends on an independent postcondition. Each turn the runner clears benign popups, picks the first step
whose `when` matches the screen, runs it, and records it. A reordered page, a surprise popup or a reload is handled by
whichever step matches what is actually on screen. An unrecognised page escalates with its headings and buttons as a
suggested patch.

Postconditions check state, not clicks (R8):
- **Plan:** the button's name becomes "Value Plus has been selected" **and** the cart reads above $0.00.
- **Fields:** each value is read back until it sticks (the portal's reactive framework wipes fields).
- **Checkout pages:** the URL must move on.

Budgets cover steps (40), retries per step, total time (10 min, because the portal's address check alone takes about 17 s),
model calls (6) and heals (10). Hitting any budget escalates.

## Healing strategy (R5)

| Level | Mechanism | Example on this portal |
|---|---|---|
| L0 | Re-observe: wait, centre the element (a sticky address bar covers the bottom of the viewport), try visible duplicates, dismiss popups through a rule table | "Heads up!" popup, silent no-op plan click, cart dropping to $0.00 after choosing a modem (all real portal behaviour) |
| L1 | Heal memory, then fallback locators in order: role and name, label, CSS hint | renamed address ID → role textbox; "Build Your Plan" → "See plans" → `a.okbutton` |
| L2 | The model gets the goal and a pruned, redacted list of visible elements and returns **an index only** | plan buttons lose `aria-label` and `data-product-name`, and their text becomes "Add to cart"; the model picks the one under the "Value Plus" heading |
| L3 | Goal-based step selection re-plans from page state, not step order. If the address-and-plan flow gets stuck, the page is reloaded and the flow retried (up to 3 times, as the legacy script did) | step order changes; the router/plan cart interaction |
| L4 | Escalate with evidence and a suggested patch (intent, locators tried, model answer) | OTP, CAPTCHA, unknown page, budget spent |

Rules applied to every heal:
- A heal is only **proposed** by the resolver. It is committed (reported and saved to `heal-memory/`) after the step's postcondition passes; otherwise it is logged as rejected.
- The model chooses *where*, never *what*. Values always come from the payload, and the action type is fixed by the intent.
- A deterministic validator checks each model proposal: the index exists, the role fits the action, the element is not on a deny list for the intent, and it is not a payment element.
- Heal memory is a sorted JSON file reviewed with `git diff`. A human sets `status: rejected` to block a record.
- Page text is data. Elements whose text looks like instructions are dropped from the model's view and logged.

## Card handling (R6): planner and executor split

I chose **Option A (secret injection at the tool layer), made structural**. The planner, including the model, never has a
handle to card data. The payment step calls `runPayment(ctx)`, which takes no card arguments and returns only
`{ ok, last4, maskedError }`.

The executor:
1. Refuses if the payment ledger shows this `jobId` already reached Pay Now. There is no auto-retry, so no double charge.
2. Waits for the card iframes and verifies their origin is exactly `https://secure.tillpayments.com`. Any other origin, or a missing frame, escalates. There is no healing on payment fields.
3. Checks the order summary (plan, total) against the payload and the cart total captured earlier.
4. Resolves `cardRef` from the vault **just in time**. The vault writes an audit line (job, time, caller, outcome) with no values.
5. Types into the iframes, verifies by **digit count only**, wipes its references, and records `submitting` before clicking Pay Now.
6. Answers the 3-D Secure challenge deterministically ("Authenticated (ECI 05)"). This only happens for `vault://test-cards/` references, and only on the portal or `*.tillpayments.com` origins.

Answers to the handout's questions:
- **What the model sees on the payment page:** nothing. The runner sets `guarded = true` on entry, and `groundWithModel` refuses any guarded call. Every model call is written to `model-calls.jsonl`, so the proof is a file the leak check scans.
- **Where the card could land, and how it is checked:**
  - Tracing, video and HAR are never enabled.
  - No screenshots or ARIA dumps are taken on guarded pages (an ARIA snapshot would include the expiry field's value).
  - Executor errors are replaced with masked messages, because Playwright errors can echo arguments.
  - Every log line passes a redactor that masks Luhn-valid numbers, CVV-labelled digits and API keys.
  - `npm run leak-check` scans `runs/` and `heal-memory/`, PNGs included, for the vault's PANs (spaced or not), any Luhn-valid card-like number, and the CVV next to a label. `--self-test` proves it catches a planted leak.
- **Executor can't find the iframe:** it escalates after 60 s. The agent never improvises.
- **3-D Secure:** the challenge is handled inside the executor by fixed code. No new page content reaches the model.

The CVV is never stored by the agent. In production it would come from the customer for each job, either through a
human hand-off (Option C) or through a detokenising proxy (Option B), so the PAN never enters this process.

## Trade-offs

- **Deterministic first, model last.** A clean run makes zero model calls; the model is only a healing tool.
  This costs some "agentic" flexibility but makes the run cheap, repeatable and explainable.
- **The executor runs in the same process as the planner.** The boundary is a module boundary, not a process boundary. JS strings can't be zeroed, so `wipe()` limits lifetime but can't erase memory.
- **Postconditions are only as strong as their checks.** A good example: the order summary check first failed because it ran before the page rendered. It refused to pay, which is the safe failure.
- **Stable `jobId` from a payload hash.** This makes the payment ledger idempotent, at the cost of needing a fresh payload per demo run (`npm run new-job`).

## With another week

- Run the executor in a separate process with its own browser context (CDP), so the planner has no page access during payment.
- Add a detokenising proxy, so the PAN never enters this process.
- L3 for new mandatory fields: map each validation error to a payload `valueRef` chosen by the model from an allow-list.
- Run every handout failure scenario in CI against the mutation layer, and record heal-acceptance rates.
- Move second-retailer support (R11) into config: intents, step detectors and popup rules per retailer, sharing the same runner.
