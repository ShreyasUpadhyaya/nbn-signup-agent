# NBN Sign-up Agent

An agent that completes the Tangerine NBN broadband sign-up on the test portal. It heals itself
when the portal changes, and it pays through an isolated executor, so no model ever sees card data.

> **Built with:** Claude Opus 5.5 via Claude Code for core architecture, planning, and healing system design.

- **Design note:** [docs/design-note.md](docs/design-note.md)
- **Portal recon:** [docs/portal-recon.md](docs/portal-recon.md)
- **What was built:** [WHAT_I_BUILT.md](WHAT_I_BUILT.md)
- **Video script:** [VIDEO_SCRIPT_CLEAN_RUN.md](VIDEO_SCRIPT_CLEAN_RUN.md)
- **Test cases (manual steps):** [TEST_CASES.md](TEST_CASES.md)
- **Interview prep:** [INTERVIEW_QA.md](INTERVIEW_QA.md)
- **Overnight report (known issues fixed and tested):** [REPORT.md](REPORT.md)
- **Plan:** [PLAN.md](PLAN.md)

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env          # MODEL_PROVIDER=gemini + GEMINI_API_KEY (or openai + OPENAI_API_KEY); used only for L2 healing
```

**Vault stub.** It lives outside the repo, at `~/.nbn-agent/vault.json` (or set `VAULT_PATH`):

```json
{ "test-cards/visa-success": { "pan": "<test card number>", "cvv": "<cvv>", "expiry": "12/30" } }
```

Use only the public test card from the handout appendix.

## Run

```bash
npm run job -- --fresh                            # clean run on a fresh copy of the sample payload (headed browser)
npm run job -- --fresh --mutate                   # same journey on a mutated portal (self-healing demo)
npm run job -- payloads/sample-job.json           # run a specific payload as-is
npm run leak-check                                # scan all run output for the card number / CVV
npm run leak-check -- --self-test                 # prove the scanner catches a planted PAN
npm test                                          # offline suite: every failure scenario against local fixture pages (~17 min, no network)
```

| Flag | Effect |
|---|---|
| `--fresh` | Copy the payload (default: the sample) with a new throwaway email and `jobId`, then run that |
| `--mutate` | Inject the mutation layer ([src/mutation/mutate.ts](src/mutation/mutate.ts)) |
| `--dry-run` | Run everything up to the payment page, check the order summary and the card-iframe origins, and stop before the card is resolved |
| `--no-model` | Disable L2 model healing (the run escalates instead) |
| `--headless` | Hide the browser (headed is the default; reCAPTCHA is less likely to interfere) |

Each run writes `runs/<jobId>-<time>/`:

- `report.json`: the result
- `run.log`: redacted
- step screenshots (none of the payment page)
- `model-calls.jsonl`: every prompt and response sent to the model
- `confirmation-<transactionId>.png`

The process exits with 0 on success, 3 when escalated, 1 when failed.

**Why a new payload per run.** The portal starts asking for an email OTP after repeated sign-ups with the
same address. The payment ledger (`runs/payment-ledger.json`) also refuses to pay twice for the same `jobId`.

## Result shape

```json
{
  "jobId": "job-10141730", "status": "success", "transactionId": "1791999144TCO",
  "completedSteps": ["address", "plan", "router", "orderNow", "login", "contact", "serviceAddress", "connection", "donation", "payment", "confirmation"],
  "healingEvents": [], "warnings": [], "paymentState": "completed", "cardLast4": "1111",
  "modelCalls": 0, "evidenceDir": "runs/job-10141730-…"
}
```

## Self-healing demo

1. Clear healed locators first: `npm run heal:reset`.
2. Run on the mutated portal: `npm run job -- --fresh --mutate`. This shows L0 (promo popup), L1 (renamed ID, relabelled button) and L2 (plan buttons lose their names, so the model re-grounds them).
3. Run `npm run job -- --fresh --mutate` again. The L2 heal is now reused from `heal-memory/tangerine.json` at L1 cost, with no model call.
4. Review the heals with `git diff heal-memory/`. Set `"status": "rejected"` on any record you don't trust.

## Layout

| Path | Purpose |
|---|---|
| [src/agent/runner.ts](src/agent/runner.ts) | The agent loop: observe, pick the step that matches the page, act, verify, under budgets |
| [src/agent/steps.ts](src/agent/steps.ts) | The journey as goal-based steps with postconditions |
| [src/agent/popups.ts](src/agent/popups.ts) | Popup rules (L0), CAPTCHA detection |
| [src/browser/resolver.ts](src/browser/resolver.ts) | Healing ladder (primary, L0, L1, heal memory, L2) and heal commit/reject |
| [src/browser/observe.ts](src/browser/observe.ts) | The pruned, redacted element list the model sees; prompt-injection filter |
| [src/llm/ground.ts](src/llm/ground.ts) | L2 model call: chooses an element index only |
| [src/payment/](src/payment) | Vault stub and the deterministic payment executor |
| [src/security/](src/security) | Redaction and the leak check |
| [src/mutation/mutate.ts](src/mutation/mutate.ts) | Mutation layer |
| [src/agent/new-fields.ts](src/agent/new-fields.ts) | L3: fill a new required field from the payload, or escalate |
| [tests/](tests) | Offline test suite and fixture portal |
| `heal-memory/` | Healed locators, committed so they can be reviewed as diffs |
