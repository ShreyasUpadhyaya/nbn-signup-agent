# Test cases: how to run each one by hand

This covers every test the handout asks for:
- **Part A:** the live-demo checks (Section 9)
- **Part B:** the 19 failure scenarios (Section 8)
- **Part C:** the portal changes the agent must survive (Section 6)

For each one it gives the command, what to look for, and the expected outcome.

## Before you start

1. `.env` has `MODEL_PROVIDER=gemini` and your `GEMINI_API_KEY`.
2. The vault stub exists at `~/.nbn-agent/vault.json`.
3. Run everything from the project folder.

## How to read a result

Every run prints a JSON report and saves `runs/<jobId>-<time>/`, which contains:
- `report.json`: the result
- `run.log`: what the agent did, step by step
- cropped step screenshots

`status` and the exit code tell you the outcome:

| `status` | Exit code | Meaning |
|---|---|---|
| `success` | 0 | Journey finished, transaction ID captured |
| `escalated` | 3 | Stopped safely and handed over to a human; `reason` says why |
| `failed` | 1 | A known wrong outcome; `reason` says why |

## Useful flags

| Flag | Effect |
|---|---|
| `--fresh` | Copies the payload with a new throwaway email and job ID. Use it for almost every run. |
| `--dry-run` | Stops on the payment page before the card is touched. **No order is created.** |
| `--mutate` | Applies the mutation layer (renamed IDs, changed labels, promo popup, injection text) |
| `--no-model` | Turns off model healing |

**Cost rule:** only runs **without** `--dry-run` that reach Pay Now create a test order. Every test below says whether it does.

**Two ways each scenario is proven:**
- **Live:** run against the real test portal. ✅ = seen working in a live run on 15 Oct. "—" = the portal can't be made to show it on demand.
- **Offline:** `npm test` runs the real agent against local fixture pages that reproduce the scenario ([tests/offline.test.ts](tests/offline.test.ts)). No network; about 17 minutes for all 20 tests.

---

## Part A: Live-demo checks (Section 9)

### A1. Clean run with payment ✅ (creates 1 test order)

```
npm run job -- --fresh
```
**Look for:**
- `"status": "success"`
- a `transactionId` such as `1791999144TCO`
- all 11 steps in `completedSteps`
- `"modelCalls": 0`
- `"cardLast4": "1111"`

**Screenshots:** `01-address.png` … `09-donation.png`, plus `confirmation-<id>.png`. There is none of the payment page, by design.

### A2. Clean dry run ✅ (no order)

```
npm run job -- --fresh --dry-run
```
**Expect:** `escalated` with reason "dry run: summary and card-iframe origins verified; stopped before the card was resolved".

### A3. Self-healing run under mutation ✅ (1 order; add `--dry-run` for none)

```
npm run heal:reset
npm run job -- --fresh --mutate
```
**Look for these lines in the output:**
- `HEAL L0 popup.dismiss`: the injected "Spring Sale!" popup was closed
- `HEAL L1 address.input`: the address box ID was renamed and found by its role
- `HEAL L1 address.buildYourPlan`: "Build Your Plan" became "See plans"
- `HEAL L2 plan.choose[VALUE PLUS]`: the plan buttons lost their names, and Gemini picked the right one
- `HEAL L1 contact.firstName`: the first-name ID was renamed
- `prompt-injection text found … treated as data and ignored`

**Report:** `healingEvents` lists each heal, and `modelCalls` is 1.

### A4. Heal memory reuse ✅ (1 order; add `--dry-run` for none)

Run straight after A3, **without** `heal:reset`:
```
npm run job -- --fresh --mutate
```
**Expect:** the same heals shown as `HEAL L1-memory …`, and `"modelCalls": 0`.

To review what was learned: open `heal-memory/tangerine.json` and check each record's `level`, `evidence` and `status`.

### A5. Leak check ✅ (no order)

```
npm run leak-check
npm run leak-check -- --self-test
```
**Expect:**
- the first command prints `leak check passed: N file(s) … contain no card number or CVV`
- the self-test proves the scanner catches a planted card number
- if anything leaked, the command exits non-zero

---

## Part B: The 19 failure scenarios (Section 8)

| # | Scenario | Expected outcome | How to trigger live | Order? | Live | Offline |
|---|---|---|---|---|---|---|
| 1 | No address suggestions in 30 s | Recover (manual entry) or escalate | B1 | No | ✅ both paths | ✅ |
| 2 | Manual form shown after a suggestion | Recover or escalate | — | No | — | ✅ |
| 3 | Disambiguation, no exact match | Recover with a warning | B3 | No | ✅ | ✅ |
| 4 | Plan card not found | Reload and retry ×3, then fail | B4 | No | ✅ | ✅ |
| 5 | Plan click does nothing | Recover from state | Happens naturally | No | ✅ | ✅ |
| 6 | Cart drops to $0 after modem | Re-select plan | Happens naturally | No | ✅ | ✅ |
| 7 | Cart still $0 at Order Now ×3 | Fail | — | No | — | ✅ |
| 8 | "Hold on!" popup (router, no plan) | Fail | — | No | — | ✅ |
| 9 | Email OTP appears | Escalate with session state | B9 (not guaranteed) | No | — | ✅ |
| 10 | Next after email does nothing | Retry ×3 | Happens naturally | No | ✅ | — |
| 11 | Fields wiped after filling | Re-fill until they stick | Happens naturally | No | ✅ | ✅ |
| 12 | AVC ID check fails | Provide Later + provider | B12 | No | ✅ | — |
| 13 | Process Order click does nothing | Retry up to 30 s | Happens naturally | No | ✅ | — |
| 14 | Card reference can't be resolved | Escalate | B14 | No | ✅ | ✅ |
| 15 | Card iframe missing or wrong origin | Escalate | B15 | No | ✅ | ✅ |
| 16 | No 3-D Secure and no transaction ID in 60 s | Fail (state unknown) | — | — | — | ✅ |
| 17 | Interrupted / timed out after Pay Now | Escalate, never retry | B17 | Yes | not run (creates an order) | ✅ ledger refuses the rerun |
| 18 | Prompt injection on the page | Ignore, log, continue | A3 | No* | ✅ | ✅ |
| 19 | Selector, label or step-order change | Heal | A3 | No* | ✅ | ✅ (step order) |

\* Add `--dry-run` to A3 for no order.

The test payloads used below are in [payloads/tests/](payloads/tests/).

### B1. No suggestions → manual entry (scenario 1)

**Recover path.** The address text gets no suggestions, but the structured fields exist:
```
npm run job -- payloads/tests/s01-no-suggestions-manual-entry.json --fresh --dry-run
```
**Look for:**
- `no suggestions within 30 s`
- `switching to manual address entry`
- the run continues to the payment page

**Escalate path.** There is no structured address to fall back on:
```
npm run job -- payloads/tests/s01b-no-suggestions-no-structured-address.json --fresh --dry-run
```
**Expect:** `escalated`, with the reason "Address Not Found: no suggestions for "Zqxv Rochester Wy, Mdw Sprngs" and no structured address to fall back on". The typed value is the evidence.

> If the portal still finds suggestions for the nonsense text, it will choose one. In that case, make `fullAddress` in the file even less like a real address.

### B2. Manual form after a suggestion (scenario 2)

This can't be triggered on demand; the portal decides when to show the form. Code: `awaitAddressResult` in [src/agent/steps.ts](src/agent/steps.ts).
- If the "check your address manually" form appears, the agent fills the structured fields once.
- If the portal still refuses, the run escalates with "Address Not Found: the portal refused the structured address".

There is no reload in this path, as the handout says.

### B3. Disambiguation, no exact match (scenario 3)

```
npm run job -- payloads/tests/s03-ambiguous-address.json --fresh --dry-run
```
**Look for:**
- `address suggestion chosen: "17 ROCHESTER WAY, MEADOW SPRINGS WA 6210" (closest match)`
- a `warnings` entry in the report: "address: no exact suggestion; chose …"
- the run continues

The payload has a structured address, so only suggestions in its suburb and postcode (MEADOW SPRINGS, 6210) are eligible. Before this rule, the agent picked "17 Rochester Way, **DIANELLA**", a different property. If none is eligible, it uses manual entry instead (`no suggestion is in MEADOW SPRINGS 6210 … not choosing a different property`).

### B4. Plan card not found (scenario 4)

```
npm run job -- payloads/tests/s04-plan-does-not-exist.json --fresh --dry-run --no-model
```
**Look for:** `reloading and retrying the address and plan flow (1/3)`, then `(2/3)`, then `(3/3)`.

**Expect:** `failed`, with "… gave up after 3 reloads of the address and plan flow". This takes about 4 minutes.

`--no-model` keeps the model out. Without it, Gemini would be asked to find a "GOLD UNLIMITED" button. Whatever it picked would be rejected, because the "has been selected" check would never pass, but it would spend model calls.

### B5, B6, B10, B11, B13: happen on their own

These are real portal quirks, and they appear in most runs. After any run, search `run.log` for:

| # | Text to search for |
|---|---|
| 5 | `plan.choose[VALUE PLUS]: click had no visible effect` followed by `plan selected` |
| 6 | `cart dropped to $0.00 after choosing the router; re-selecting the plan` |
| 10 | `login.next: click had no visible effect` |
| 11 | `value did not stick, re-filling` |
| 13 | `connection.processOrder: click had no visible effect` |

### B7. Cart still $0 at Order Now (scenario 7)

This can't be forced on the live portal. Code: the `orderNow` step in [src/agent/steps.ts](src/agent/steps.ts). After 3 recovery attempts it fails with "plan missing from cart: cart still $0.00 at Order Now after 3 recovery attempts".

### B8. "Hold on!" popup (scenario 8)

This can't be forced on the live portal. Code: the rule in [src/agent/popups.ts](src/agent/popups.ts) (line 23). The popup fails the run with "Hold on! popup: router in cart but no plan; refusing to order a modem alone".

### B9. Email OTP (scenario 9)

The portal asks for an OTP when the same email signs up repeatedly. Use the sample payload **without** `--fresh`, so the email stays the same:
```
npm run job -- payloads/sample-job.json --dry-run
```
Repeat it until the OTP appears. It is not guaranteed on any one try.

**Expect:**
- `escalated`, with "email OTP requested at checkout login: hand over to a human (session state saved)"
- `session-state.json` saved in the run folder

### B12. AVC ID check fails (scenario 12)

```
npm run job -- payloads/tests/s12-invalid-avc-id.json --fresh --dry-run
```
**Look for:**
- the report warning "AVC ID check failed within 5 s; chose Provide Later"
- `08-connection.png` showing "Provide Later" selected and the provider "Exetel"

### B14. Card reference can't be resolved (scenario 14)

This must run **without** `--dry-run`, because a dry run stops before the card is looked up. No order is created: the lookup fails before anything is typed or Pay Now is clicked.
```
npm run job -- payloads/tests/s14-unknown-card-ref.json --fresh
```
**Expect:**
- `escalated`, with a masked reason "card reference could not be resolved"
- `"paymentState": "not-started"`
- a `not-found` line at the end of `~/.nbn-agent/vault-audit.log`

### B15. Card iframe has an unapproved origin (scenario 15)

There's no flag for this, so it needs a temporary code change:
1. In [src/payment/executor.ts](src/payment/executor.ts) line 15, change `'https://secure.tillpayments.com'` to `'https://example.invalid'`.
2. Run `npm run job -- --fresh --dry-run`.
3. **Expect:** `escalated`, with "card iframe origin not approved (https://secure.tillpayments.com)". Nothing is typed.
4. Undo the change: `git checkout -- src/payment/executor.ts`.

This is also a good candidate for the "small live change" the interviewers will ask for.

### B16. No 3-D Secure and no transaction ID (scenario 16)

This can't be forced on the live portal. Code: the end of `runPayment` in [src/payment/executor.ts](src/payment/executor.ts). After 60 s it returns "neither 3-D Secure nor a transaction ID appeared within 60 s; payment state unknown, reconcile manually". The ledger records `unknown`, so the job can never be paid again automatically.

### B17. Interrupted after Pay Now (scenario 17): creates 1 test order

1. Make a payload you can run twice:
   ```
   npm run new-job
   ```
   It prints a path such as `payloads/generated/job-XXXX.json`.
2. Run that file **without** `--fresh`, and press **Ctrl+C** as soon as `Pay Now clicked` appears:
   ```
   npm run job -- payloads/generated/job-XXXX.json
   ```
3. Check `runs/payment-ledger.json`: that job ID should read `unknown`.
4. Run the **same file** again:
   ```
   npm run job -- payloads/generated/job-XXXX.json
   ```
   **Expect:** `escalated`, with "a payment for job job-XXXX was already unknown …; manual reconciliation required, not retrying". The card is never resolved a second time.

---

## Part C: Portal changes the agent must survive (Section 6)

| Change | Expected | How it is tested | Verified |
|---|---|---|---|
| Renamed or removed ID | L1, else L2 | A3: address box and first-name IDs renamed | ✅ live |
| Label text changed | L1 | A3: "Build Your Plan" → "See plans" | ✅ live |
| Layout moved / names removed | L2 | A3: plan buttons lose their names; Gemini re-grounds | ✅ live |
| New blocking popup | L0 or L2 | A3: "Spring Sale!" promo popup | ✅ live |
| Silent no-op click | L0 + state check | B5 (natural) | ✅ live + offline |
| Step order changed | L3 | Offline: donation moved before contact. Each page's postcondition is "left this page"; landing somewhere unexpected records an L3 re-plan, and the runner picks the step for that page. | ✅ offline |
| New mandatory field | L3 if the payload can answer it, else L4 | Offline: a new required "Confirm Email Address" is filled from `customer.email` (L3); a new required consent checkbox escalates (L4), because consent is never invented. | ✅ offline |
| Payment iframe changed | L4 unless the origin is approved | B15 (live) and offline | ✅ live + offline |

## Part D: Offline test suite

```
npm test
```
It runs 20 tests in about 17 minutes, with no network. Each test drives the real agent (runner, steps, healing, payment executor) through [tests/fixture-portal.ts](tests/fixture-portal.ts), which answers every portal and Till request locally. It uses its own vault and payment ledger in `runs-test/`, never the real ones.

To run one test:
```
npx tsx --test --test-name-pattern="Hold on" tests/offline.test.ts
```

## Suggested order if you only have 30 minutes

1. A2 dry run (2 min) to confirm the setup
2. A5 leak check (seconds)
3. B12 (2 min) and B14 (2 min): safe and quick
4. B15 (2 min), then revert the change
5. A3 + A4 with `--dry-run` (5 min) for the healing demo
6. A1 (2 min) last, as the one real order
