# Overnight report: 15 Oct 2026

What you asked for before going to sleep:
1. Build and test fixes for the known issues.
2. Do the offline tests first.
3. Write a document of interview questions.

**Everything below was run, not assumed.** Where something is only proven offline, it says so.

## Bottom line

- **Live portal:** the clean run with test payment **succeeded** after all of tonight's changes (transaction **1792010918TCO**, card ending 1111, 0 model calls). The mutated healing demo still works: run 1 healed at L0/L1/L2 with 1 Gemini call, and run 2 reused heal memory with **0 model calls**.
- **Offline suite (`npm test`):** **20 of 20 pass** (final run about 17 min, no network).
- **Leak check:** passed over 498 run files; `--self-test` passed. Each offline test that pays also runs the scan over its own output.
- **New documents:** [INTERVIEW_QA.md](INTERVIEW_QA.md) (interview prep), this report, and updated [TEST_CASES.md](TEST_CASES.md), [README.md](README.md), [docs/design-note.md](docs/design-note.md) and [WHAT_I_BUILT.md](WHAT_I_BUILT.md).

## Known issues: what was wrong, what I changed, how it was tested

| # | Issue | Was it real? | Change | Proven by |
|---|---|---|---|---|
| 1 | **"Sorry! Address Not Found" inside the suggestion list.** The agent clicked it as an address and waited 60 s. | Yes, found by live scenario 1 | The suggestion reader ignores "not found" entries, so the agent goes to manual entry | Live scenario 1 ✅ + offline test ✅ |
| 2 | **Closest suggestion was a different property** ("17 Rochester Way, **DIANELLA**") | Yes, found by live scenario 3 | With a structured address, only suggestions in the payload's suburb and postcode are eligible; otherwise manual entry | Live scenario 3 ✅ (picked MEADOW SPRINGS) + offline test ✅ |
| 3 | **Router flakiness**, the "stuck repeating step router" reloads. Root cause: after a re-render, the chosen modem's button reads "Choose" but is still pressed, so the agent clicked again and deselected it. | Yes, found in a live page snapshot | A pressed "Choose BYO Modem" now counts as selected | Offline test with that exact quirk ✅. The final live run needed no reloads. |
| 4 | **Slow portal:** no address result in 60 s escalated immediately | Yes, seen live once | Now a timeout: the shop flow reloads and retries (×3), then fails. The limit is a budget (`addressResultMs`). | Offline test ✅ |
| 5 | **Gemini free-tier rate limit (429)** would escalate a heal | Risk | Model calls retry twice with backoff on 429 and 5xx | Offline test against a local fake API ✅ |
| 6 | **Scenario 7's message was unreachable:** a cart stuck at $0 at Order Now reloaded instead of failing with "plan missing" | Yes, found by reading the code | Order Now runs its own 3 recoveries, then fails "plan missing from cart" | Offline test ✅ |
| 7 | **Scenario 16 was reported as "escalated";** the handout says Fail | Yes | No 3-D Secure and no transaction ID → **failed**. The ledger still records `unknown`, so it's never retried. Unexpected errors after Pay Now still escalate (scenario 17). | Offline test ✅ |
| 8 | **Scenario 14's reason was vague** ("failed at resolve card") | Yes | The reason now names the reference and says there's no fallback | Live ✅ + offline test ✅ |
| 9 | **Popups without a heading** were logged as unknown `""` and handled badly | Yes, seen live after a reload | The dialog's accessible name is used as its heading | Covered by the live reruns |

## The two handout items that weren't built: now built

| Item | Before | Now | Proven by |
|---|---|---|---|
| **Step order changed (L3)** | Steps were picked by page, but each postcondition hard-coded the next page. Login "failed" if the portal went to donation. | Postcondition is "left this page". An unexpected destination is logged as an `L3` heal ("step order changed … re-planning from page state"), and the runner picks the step for that page. | Offline: donation moved before contact ✅ |
| **New mandatory field (L3, else L4)** | Escalated with the portal's error message | New file [src/agent/new-fields.ts](src/agent/new-fields.ts). A new **required text field** is filled from the payload: a label table first (e.g. "Confirm Email" → `customer.email`), otherwise the model picks a payload *field name* from the allow-list. It never sees values. A new required **checkbox or radio escalates**, because consent is never invented. | Offline: "Confirm Email Address" filled (L3) ✅; consent checkbox escalated (L4) ✅ |

## Live scenario results (real portal, dry runs, no orders)

| Scenario | Result |
|---|---|
| 1. No suggestions → manual entry | ✅ recovered and reached the payment page (after fix #1) |
| 1. No suggestions, no structured address | ✅ escalated "Address Not Found: no suggestions for … and no structured address to fall back on" |
| 3. Ambiguous address | ✅ chose the MEADOW SPRINGS suggestion and warned (after fix #2) |
| 4. Plan doesn't exist | ✅ reloaded 3 times, then failed |
| 12. Invalid AVC ID | ✅ warning "AVC ID check failed", chose Provide Later, continued |
| 14. Unknown card reference | ✅ escalated; nothing typed; vault audit logged `not-found` |
| 15. Unapproved card iframe origin | ✅ escalated before the card was resolved (temporary code change, reverted) |

## Offline test suite

`npm test` runs the **real agent** against local fixture pages ([tests/fixture-portal.ts](tests/fixture-portal.ts)). It never contacts the portal, and it uses its own vault and ledger in `runs-test/`.

| Test | Result |
|---|---|
| Clean journey with portal quirks: silent plan click, cart drop after router, router reading "Choose" while pressed, wiped field, injection text, 3-D Secure challenge → **transaction ID captured** | ✅ |
| Scenario 1: "Sorry! Address Not Found" ignored → manual entry | ✅ |
| Scenario 1: no suggestions and no structured address → escalate | ✅ |
| Scenario 2: manual form refuses → Address Not Found, no reload | ✅ |
| Scenario 3: other-suburb suggestion never chosen → manual entry | ✅ |
| Slow portal: address timeout → reload ×3 | ✅ |
| Scenario 4: plan not found → reload ×3 → fail | ✅ |
| Scenario 7: cart $0 at Order Now ×3 → fail "plan missing" | ✅ |
| Scenario 8: "Hold on!" → fail | ✅ |
| CAPTCHA → escalate | ✅ |
| Scenario 9: OTP → escalate + `session-state.json` | ✅ |
| Step order changed → L3 re-plan, journey completes | ✅ |
| New required text field → L3 fills from `customer.email` | ✅ |
| New required consent checkbox → L4 escalate | ✅ |
| Scenario 14: unknown card reference → escalate, nothing typed | ✅ |
| Scenario 15: unapproved iframe origin → escalate before resolve | ✅ |
| Scenarios 16 + 17: no 3-D Secure / no ID → fail, ledger `unknown`; the same job is refused on rerun | ✅ |
| Redaction (card number, CVV, OpenAI and Gemini keys) | ✅ |
| Payload rules (no raw card; allow-listed fields only) | ✅ |
| Model retry on HTTP 429 | ✅ |

**Checking the tests themselves:** I temporarily removed the router fix and reran the clean-journey test. The agent ran the router step twice (re-clicking the selected modem), and the test now asserts exactly one router step, so it catches that bug. Then I restored the fix.

## Things to know before the demo

- **Residual portal flakiness.** The plan/router can still ping-pong live (re-selecting the plan sometimes drops the router). It always settled within budget tonight, sometimes after a few extra steps. If you see repeated `plan`/`router` steps, that's the cause.
- **Under `--mutate`, the address box may get no suggestions** (renaming its ID can break the portal's own autocomplete). The agent then uses manual entry, which costs about 30 s, and continues.
- **Before the live demo:** run `npm run heal:reset`, so the first mutated run shows the L2 Gemini heal again.
- **Scenario 17 wasn't run live,** because it needs a real order and a well-timed Ctrl+C. It's proven offline (the ledger refuses the rerun).
- **The design note is about 1,270 words with tables.** It should fit two pages, but check it in print if they're strict.

## What changed in the code tonight

| File | Change |
|---|---|
| `src/agent/steps.ts` | Suggestion filters (not-found, suburb/postcode); router pressed state; address timeout → reload; scenario 7 recoveries; scenario 16 → Fail; "left this page" postconditions + L3 reorder note; L3 new-field hook |
| `src/agent/new-fields.ts` | **New:** L3 new mandatory field |
| `src/agent/popups.ts` | Dialog name used when there's no heading |
| `src/agent/runner.ts` | `prepare`/`runsDir` options (for tests); `nextStep` exported; Fail stays Fail after Pay Now |
| `src/agent/context.ts` | `addressResultMs` budget |
| `src/llm/ground.ts` | Retry on 429/5xx; `chooseValueRef` (payload field name only); `MODEL_BASE_URL` |
| `src/payment/executor.ts` | Clear reason for an unknown card reference; `PAYMENT_LEDGER` override (tests) |
| `src/security/leak-check.ts` | Importable by tests (CLI unchanged) |
| `tests/` | **New:** offline suite and fixture portal |
