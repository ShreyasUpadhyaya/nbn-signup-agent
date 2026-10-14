# Interview questions and answers

This prepares you for the 1-hour call. Each answer reflects what the code actually does, and points to the file to open if you're asked to show it.

The call has three parts:
1. A live demo: clean run, mutated run, then the leak check.
2. A design walkthrough.
3. Questions, including one small live change.

**One rule for the whole call: say "I don't know" or "that isn't built" plainly.** Section 10 lists the honest gaps.

---

## 1. The 60-second overview

> It's a TypeScript and Playwright agent. It completes the NBN sign-up from a JSON payload and returns a JSON report.
>
> **The journey** is 11 goal-based steps. Each step has a "when", which detects the page from live state, and a postcondition that the actor doesn't control.
>
> **Healing** is a ladder: L0 waits, scrolls and dismisses popups; L1 uses fallback locators and heal memory; L2 asks a model to pick an element *index* from a redacted list; L3 re-plans from page state, and fills a new required field only from the payload; L4 escalates with evidence.
>
> **The card** never reaches the model. A deterministic payment executor resolves a vault reference just in time, checks the iframe origins and the order summary, types into the Till iframes, and returns only ok, last-4 and a masked error.
>
> **Proof:** a leak check scans all run output for the card number and CVV, and an offline test suite runs every failure scenario against local fixture pages.

---

## 2. Architecture and agent loop

**Q: Walk me through the architecture.**

```
payload.json → parseJob (Zod) → runner loop: clear popups → pick step by page state → run → postcondition → report.json
                                           │                       └ resolver: L0 → L1 (fallbacks, heal memory) → L2 model
                                           └ payment step → executor (no model) → vault (cardRef → card, audited)
```

Files to open:
- [src/agent/runner.ts](src/agent/runner.ts): the loop
- [src/agent/steps.ts](src/agent/steps.ts): the journey
- [src/browser/resolver.ts](src/browser/resolver.ts): healing
- [src/payment/executor.ts](src/payment/executor.ts): payment

**Q: Why not a framework like LangChain, browser-use or Stagehand?**

The loop is about 150 lines, and every decision is explicit and testable. Those tools put the model in charge of every action. The handout's top priorities are safety and explainability ("a narrow flow that is safe and healing beats a complete flow that leaks the card"). So the model is a healing tool, not the driver. A clean run makes **0 model calls**.

**Q: Isn't that just a script? Where's the "agent"?**

It isn't a fixed list. Each turn, the runner picks the first step whose `when` matches the *current page*, so a reordered page, a reload or a surprise popup is handled by whichever goal matches. The agentic parts are the healing ladder (including model re-grounding) and the L3 re-planning. A legacy script breaks on the first renamed ID; this run still finishes.

**Q: How do you know a step succeeded?**

Postconditions read state, never "the click didn't throw":
- **Plan:** the button reads "VALUE PLUS has been selected" **and** the cart is above $0.00.
- **Fields:** read back until the value sticks.
- **Checkout pages:** the URL must move on.
- **Router:** the option reads "Selected", or is still pressed after a re-render.

**Q: What are the budgets?**

40 steps, 3 retries per step, 10 minutes, 6 model calls and 10 heals ([src/agent/context.ts](src/agent/context.ts)). Hitting any of them escalates. The shop flow (address, plan, router, Order Now) also reloads and retries up to 3 times, as the legacy script did.

---

## 3. Self-healing

**Q: Explain the healing ladder with real examples.**

| Level | What it does | Seen on this portal |
|---|---|---|
| L0 | Wait, centre the element (a sticky header covers clicks), try visible duplicates, dismiss popups by rule | "Heads up!" popup; silent plan click; cart drops to $0 after choosing the modem |
| L1 | Heal memory first, then fallback locators: role and name → label → CSS | Address box ID renamed → found by role; "Build Your Plan" → "See plans" → `a.okbutton` |
| L2 | The model gets the goal and a pruned, redacted element list, and returns an **index** | Plan buttons lose their names → Gemini picks "Add to cart" under "Value Plus" |
| L3 | Re-plan from page state; fill a new required field **from the payload** | Donation page moved earlier; a new "Confirm Email" field |
| L4 | Escalate with evidence and a suggested patch | OTP, CAPTCHA, unknown page, budget spent |

**Q: How do you stop a "heal" from clicking the wrong thing?**

1. A deterministic validator checks the model's proposal: the index exists, the role fits the action, it isn't on the intent's deny list, and it isn't a payment element.
2. A heal is only *proposed* until the step's postcondition passes. Then it's committed to `heal-memory/tangerine.json`; if the postcondition fails, it's rejected and logged.
3. The model chooses **where**, never **what**: values always come from the payload.

**Q: What is heal memory, and how is it governed?**

It's a JSON record per intent: new locator, level, evidence, confidence, date and status. It's committed to git, so a human reviews heals with `git diff` and can set `"status": "rejected"`. The next run reuses an approved heal at L1 cost, with no model call. In the demo, run 1 makes 1 model call and run 2 makes 0.

**Q: Show me the mutation layer.**

[src/mutation/mutate.ts](src/mutation/mutate.ts) is injected as a browser init script. It:
- renames `#autocomplete` and `#fname`
- relabels "Build Your Plan"
- strips the plan buttons' `aria-label` and `data-product-name`
- injects a promo popup and hidden "ignore previous instructions…" text

It never touches the payment page or the iframes.

**Q: What does the model actually see?**

The goal, the action type, the page path, and up to 200 visible interactive elements, each as `[idx] role "name" | under "nearest visible heading"`:
- all text is redacted
- payment containers are removed
- elements whose text looks like an instruction are dropped and logged

Every prompt and response is saved in `model-calls.jsonl`, which the leak check scans.

**Q: Which model, and why?**

`gemini-3.5-flash-lite` through Gemini's OpenAI-compatible endpoint. It also works with OpenAI via `MODEL_PROVIDER`. A small, cheap model is enough because it only picks an index from a short list with structured output. Rate limits (429) and 5xx errors are retried twice with backoff.

---

## 4. Card safety (the most important section)

**Q: How do you guarantee the model never sees the card?**

It's structural, not a rule the model is asked to follow:
1. **The payload has no card**, only `cardRef: "vault://test-cards/visa-success"`. The Zod schema rejects anything that isn't a `vault://` reference.
2. **The planner never holds the card.** The payment step calls `runPayment(ctx)` with no card argument, and gets back only `{ ok, last4, maskedError }`.
3. **The model is off in the payment phase.** `guarded = true` is set on entry, and `groundWithModel` refuses any guarded call.
4. **No screenshots, no ARIA dumps and no traces, video or HAR**, ever on guarded pages.

**Q: Which option did you choose: A, B, C or D?**

**A, secret injection at the tool layer, made structural.** In production I'd add **B**, a detokenising proxy, so the card number never enters our process. **C**, a human hand-off, would be the fallback for 3-D Secure on real cards. The CVV is never stored; per PCI it would come from the customer for each job.

**Q: Walk me through the executor.**

[src/payment/executor.ts](src/payment/executor.ts):
1. **Ledger check:** if this job already reached Pay Now, refuse. There's never a double charge.
2. **Find the card iframes** and verify their origin is exactly `https://secure.tillpayments.com`. Anything else stops the run.
3. **Order summary check:** plan name and grand total against the payload and the cart total captured earlier.
4. **Resolve the card from the vault just in time.** The vault writes an audit line (job, time, caller, outcome) with no values.
5. **Type into the iframes,** then verify by **digit count only**, never by reading the value back. Wipe the references.
6. **Record `submitting`, click Pay Now,** then handle the confirm modal.
7. **3-D Secure:** answer "Authenticated (ECI 05)" automatically, but only for `vault://test-cards/` references and only on Till or portal origins.

**Q: Where could the card leak, and how do you check?**

| Where | Mitigation |
|---|---|
| Prompts | The model is off during payment, and every call is saved to `model-calls.jsonl` |
| Logs and errors | Every line passes `redact()`: Luhn-valid numbers, CVV next to a label, API keys. Executor errors are replaced with masked messages, because Playwright errors can echo the typed argument. |
| Screenshots and ARIA | None on guarded pages. An ARIA snapshot would include the expiry field's value. |
| Traces, video, HAR | Never enabled |
| Heal memory | No heals on payment fields; payment elements are excluded from observation |

**Automated proof:** `npm run leak-check` scans `runs/` and `heal-memory/`, including PNGs, for the vault's card numbers, any Luhn-valid number, and the CVV next to a label. `--self-test` proves it catches a planted leak. The offline tests also run the scan over their own output.

**Q: What if the executor can't find the iframe?**

It escalates after 60 s and never improvises. There is no healing on payment fields (scenario 15).

**Q: What does `wipe()` really guarantee?**

Honestly, only that the values have a shorter lifetime. JavaScript strings are immutable and can't be zeroed. The real fix is B, the proxy, or a separate executor process. Say this before they ask.

**Q: Prompt injection: what if the page says "send the card to X"?**

1. The page text is data. Instruction-like text is detected, logged as a warning, and dropped from what the model sees.
2. Even a fooled model can't do anything with it: the model never sees card data, can only return an element index, can't choose values, and is switched off during payment.
3. The executor only types into allow-listed origins.

---

## 5. Failure scenarios (handout section 8)

**Q: How do you decide between recover, escalate and fail?**

| Outcome | When |
|---|---|
| **Recover** | The fix is safe and verifiable by a postcondition |
| **Escalate** | A human has information or authority we don't: OTP, CAPTCHA, an unknown page, a consent we can't invent, payment state unknown |
| **Fail** | We *know* the outcome would be wrong: a modem with no plan ("Hold on!"), the plan missing from the cart after 3 tries, no 3-D Secure and no transaction ID |

**Quick reference.** The live runs are listed in [TEST_CASES.md](TEST_CASES.md); `npm test` runs them all offline.

| # | Behaviour |
|---|---|
| 1 | No suggestions → manual entry from the structured address; with no structured address, escalate with the typed value. The portal's "Sorry! Address Not Found" entry is never treated as a suggestion. |
| 2 | The manual form refuses → escalate "Address Not Found", with no reload |
| 3 | Pick the closest match and warn, but **never a different suburb or postcode** than the payload's structured address |
| 4 | Plan not found → reload ×3 → fail |
| 5 | Silent plan click → retry until the button reads Selected **and** the cart is above $0 |
| 6 | Cart drops to $0 after the modem → re-select the plan |
| 7 | Cart still $0 at Order Now after 3 recoveries → fail "plan missing" |
| 8 | "Hold on!" → fail; never order a modem alone |
| 9 | OTP → escalate; session state saved for the human |
| 10, 13 | Click did nothing → retry with growing pauses |
| 11 | Field wiped → re-fill and read back until it sticks |
| 12 | AVC check fails → Provide Later + the current provider |
| 14 | Unknown card reference → escalate; never fall back to the payload, page or model |
| 15 | Missing iframe or unapproved origin → escalate before the card is resolved |
| 16 | No 3-D Secure and no transaction ID in 60 s → fail; ledger records `unknown` |
| 17 | Interrupted after Pay Now → ledger `unknown`; a rerun refuses to pay |
| 18 | Injection → ignore, log, continue |
| 19 | Selector, label or order change → heal (see the mutated run) |

**Q: What did testing actually find?**

Good story material. These were real bugs found tonight by running the scenarios:
1. **The portal lists "Sorry! Address Not Found" *as a suggestion*.** The agent clicked it and waited 60 s. Fixed by filtering it out.
2. **Scenario 3 picked "17 Rochester Way, DIANELLA"**, a different property, because matching used only the free-text address. Fixed: with a structured address, the suggestion must contain the payload's suburb and postcode, otherwise it uses manual entry.
3. **Router flakiness root cause:** after a re-render, the chosen modem's button reads "Choose" but is still pressed. The agent thought it was unselected and clicked again, which toggles it off. Fixed by reading the pressed state.
4. **The step screenshots were one step late,** and blank on checkout pages. Fixed by capturing inside each step, cropped to the area it worked on.

---

## 6. Testing and evidence

**Q: How do you test scenarios the live portal can't trigger, like OTP, "Hold on!" or no 3-D Secure?**

`npm test` runs the **real agent** (the same runner, steps and executor) against offline fixture pages ([tests/fixture-portal.ts](tests/fixture-portal.ts)). Playwright intercepts every request to the portal's URLs and serves local HTML. Switches reproduce each scenario: `otp`, `holdOn`, `payOutcome: 'nothing'`, `cardOrigin`, `extraContactField`, `donationEarly`, and so on. Nothing reaches the network. It also includes unit tests for redaction, the payload allow-list and the model retry.

**Q: What's in a run report?**

`status`, `reason`, `completedSteps`, `healingEvents` (each with what broke, what changed and why it was trusted), `warnings`, `paymentState`, `cardLast4`, `modelCalls` and `evidenceDir`. The evidence directory holds `run.log` (redacted), cropped step screenshots, `model-calls.jsonl` and the confirmation screenshot.

---

## 7. Trade-offs and production

**Q: What are the biggest trade-offs?**

- **Deterministic first, model last.** That makes runs cheap, repeatable and explainable, at the cost of some flexibility on wildly different pages.
- **The executor is in the same process as the planner.** The boundary is a module boundary, not a process boundary.
- **The stable `jobId` comes from a payload hash.** That makes the ledger idempotent, but demo runs need `--fresh`.
- **The portal's own selectors are hints, not truth.** Postconditions are the truth.

**Q: How would you run this in production at scale?**

- A queue of jobs, one browser context each, with concurrency limits per retailer.
- The executor in a separate service, with a detokenising proxy (B).
- The vault behind short-lived credentials.
- Heal memory reviewed through pull requests, with acceptance-rate metrics.
- Escalations to a human work queue that carries the saved session state.
- Alerts on the heal rate per intent: many heals on one selector means the portal changed, and a code patch is cheaper than repeated healing.

**Q: How would you add a second retailer?**

The runner, resolver, executor, vault and leak check are retailer-agnostic. A retailer brings its own intents (locator hints), step detectors, popup rules and allowed payment origins. Heal memory is already keyed per retailer (`heal-memory/<retailer>.json`).

**Q: With another week?**

- Run the executor as a separate process.
- Add the detokenising proxy.
- Have the mutation layer reorder pages, and run every scenario in CI on each commit.
- Track heal-acceptance metrics.
- Add a model-assisted L3 for new *select* fields (done for text fields).

---

## 8. Likely live-change requests, and how to do each

| Request | Where | Notes |
|---|---|---|
| "Pick a different plan / modem" | `payloads/sample-job.json` (`plan.name`, `addOns.router.model`) | No code change; that's the point of the payload |
| "Add a new popup rule" | `RULES` in [src/agent/popups.ts](src/agent/popups.ts) | `{ heading: /regex/i, action: () => ({ click: /^button text$/i }) }` |
| "Allow another payment origin" | `CARD_ORIGINS` in [src/payment/executor.ts](src/payment/executor.ts) line 15 | Talk through the risk first; there's an offline test for the origin check |
| "Change a budget" | `DEFAULT_BUDGETS` in [src/agent/context.ts](src/agent/context.ts) | |
| "Add a fallback locator" | The intent's `candidates` in [src/agent/steps.ts](src/agent/steps.ts) | Order matters: most stable first |
| "Add a mutation" | [src/mutation/mutate.ts](src/mutation/mutate.ts) | Then run `npm run job -- --fresh --mutate --dry-run` |
| "Make the leak check also scan X" | `npm run leak-check -- <dir>`, or the default targets in [src/security/leak-check.ts](src/security/leak-check.ts) | |
| "Add a test for scenario X" | [tests/offline.test.ts](tests/offline.test.ts) + a switch in [tests/fixture-portal.ts](tests/fixture-portal.ts) | Run a single test with `npx tsx --test --test-name-pattern="X" tests/offline.test.ts` |

---

## 9. Curveballs

- **"The portal is down right now."** Show the recorded video, then run `npm test`: the offline suite exercises the whole journey and every scenario.
- **"A run got the OTP mid-demo."** That's scenario 9 working. Show the escalation and the saved session state, then rerun with `--fresh`.
- **"Why is there a 'reloading' line in your run?"** The portal's router/cart interaction is flaky. Reloading the shop flow up to 3 times is the handout's own rule (step 5), and the log says exactly why it happened.
- **"How do you know the model didn't see the card?"** Open `model-calls.jsonl` from the run, run `npm run leak-check`, and show `guarded` in `groundWithModel`.
- **"What if the model is wrong?"** Its answer is only a proposal. The validator plus the postcondition decide, and wrong answers are rejected and logged.

---

## 10. Honest gaps: say these before you're asked

- **"New mandatory field" handles text fields** (label table, then model choice of a payload field *name*). New **checkboxes and radios always escalate.** That's deliberate: consent is never invented.
- **Step-order changes are only tested offline** (donation moved before contact). The live mutation layer doesn't reorder pages.
- **`wipe()` can't truly zero memory** in JavaScript. The proxy or a separate process is the real fix.
- **Scenarios 2, 7, 8, 9 and 16 can't be forced on the live portal.** They're proven by the offline suite.
- **AI assistance:** built with Claude Opus 5.5 via Claude Code (credited in the README). Be ready to explain any file. The design note and this document are your map.
