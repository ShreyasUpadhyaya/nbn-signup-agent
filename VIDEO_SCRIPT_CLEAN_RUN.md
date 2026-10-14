# Video Script: Clean Run Walkthrough

**Duration:** ~3–4 minutes  
**Setup:** Visible browser window, terminal showing command and output  
**Goal:** Show the agent completing a sign-up from start to finish, with real payment

---

## Scene 1: Setup & Launch (0:00–0:30)

**On screen:** Terminal window

**Script:**
"I'm about to run the NBN sign-up agent on a clean portal. Let me show you the command."

**Action:**
```bash
npm run job -- --fresh
```

**Narration:**
"This creates a fresh payload with a new throwaway email and jobId, then runs the agent on a real browser. The `--fresh` flag is important because the portal asks for an OTP if you sign up multiple times with the same email, and the payment ledger prevents double-charging the same jobId."

**What's happening:** Browser opens in the background. Terminal shows initial log lines.

---

## Scene 2: Address Step (0:30–1:00)

**On screen:** Browser window (or switch to it now)

**What you see:**
- Portal loads with the Tangerine NBN page
- Agent types an address into the address box
- A suggestion dropdown appears
- Agent clicks the suggestion

**Narration:**
"The agent is now filling in the address. It types slowly—one key at a time—so the portal's autocomplete API has time to fire. When the suggestion appears, it clicks it. Notice the agent doesn't just click and move on; it reads back the address to confirm it stuck. The portal's React framework sometimes wipes fields, so we verify everything."

**Log output (terminal):**
```
step 1: address  (/nbn/nbn-broadband)
address suggestion chosen: "17 ROCHESTER WAY, MEADOW SPRINGS WA 6210"
```

---

## Scene 3: Plan & Router (1:00–1:45)

**On screen:** Browser scrolls to plan section

**What you see:**
- Agent clicks "VALUE PLUS" plan button
- Button changes to "has been selected"
- Cart total updates to $59.90
- Agent clicks "BYO Modem" tab
- Agent clicks "BYO Modem" option in the table
- Agent continues to next step

**Narration:**
"Now the agent picks the plan. It waits for the button to say 'has been selected' AND for the cart to show a price above $0—both conditions matter, because the portal sometimes clicks silently and the cart can drop to zero. The agent handles this by polling and retrying. Next it chooses the modem option. The router step is one of the trickiest because the portal's cart interaction is flaky, but you'll see it completes smoothly."

**Log output:**
```
step 2: plan  (/nbn/nbn-broadband)
plan selected: "VALUE PLUS has been selected", cart $59.90
step 3: router  (/nbn/nbn-broadband)
step 4: orderNow  (/nbn/nbn-broadband)
```

---

## Scene 4: Checkout (1:45–2:30)

**On screen:** Browser redirects to checkout flow

**What you see:**
- Agent stays on login page (no OTP triggered, because of the throwaway email)
- Agent moves to contact details: fills first name, last name, phone
- Agent confirms service address (billing = service)
- Agent chooses connection type ("Activate on a different address" or "Provide Later")
- Agent skips donation ("No")
- Agent reaches payment page

**Narration:**
"The agent now moves through the checkout pages: login, contact details, service address, connection type, and donation. Each page has a postcondition—the URL must change or a specific element must appear—so the agent knows when to move on. There are no surprises here because we're not on the flaky shop page anymore."

**Log output:**
```
step 5: login  (/checkout/login)
step 6: contact  (/checkout/contact-details-view)
step 7: serviceAddress  (/checkout/address-view)
step 8: connection  (/checkout/transfer-number-view)
step 9: donation  (/checkout/donate)
step 10: payment  (/checkout/payment-view)
```

---

## Scene 5: Payment (2:30–3:15)

**On screen:** Browser shows payment page with order summary and card form

**What you see:**
- Agent verifies the order summary (plan name "VALUE PLUS", total "$59.90")
- Agent finds the Till Payments card iframe
- Agent types card number (4-digit check only, not the full number)
- Agent types CVV (not shown, redacted)
- Agent types expiry month/year
- Agent types cardholder name
- Agent clicks "Pay Now"
- A 3-D Secure challenge might appear in a dropdown
- Agent auto-answers "Authenticated (ECI 05)"
- Agent polls for the transaction ID

**Narration:**
"Now the payment. This is where security matters most. The agent checks the order summary first—if the plan name or price doesn't match the payload, it stops and escalates. It then finds the card input frames. Here's the key part: the AI model **never sees any of this**. The payment executor is isolated. The model only gets back the last 4 digits and a success/error message. The card number itself is stored in a vault file outside the repo, resolved just-in-time, and never stored in memory. If the portal requires 3-D Secure, the agent auto-answers it—only for test cards, only on this portal."

**Log output:**
```
step 11: payment  (/checkout/payment-view)
order summary verified: "VALUE PLUS $59.90"
card frames origin verified: https://secure.tillpayments.com
confirm modal: boxes ticked, Pay Now clicked
3-D Secure challenge answered: Authenticated (ECI 05)
transaction ID 1791999144TCO
```

---

## Scene 6: Confirmation & Result (3:15–3:50)

**On screen:** Browser shows "YOU'RE DONE!" confirmation page, terminal shows JSON result

**What you see:**
- Confirmation page displays transaction ID, account number, order summary
- Terminal displays final JSON report with status: "success"

**Narration:**
"The agent has completed the entire sign-up. The confirmation page shows the transaction ID: `1791999144TCO`. The final report tells us all 11 steps succeeded, no healing was needed (because the portal didn't change), the payment state is 'completed', and the last 4 digits of the card are '1111'. The full report is in a JSON file in the runs folder, along with screenshots of each step and a log file—all redacted. We can also run `npm run leak-check` to verify that no card number, CVV, or API key made it into any of these files."

**Terminal output:**
```json
{
  "jobId": "job-10141730",
  "status": "success",
  "transactionId": "1791999144TCO",
  "completedSteps": ["address", "plan", "router", "orderNow", "login", "contact", "serviceAddress", "connection", "donation", "payment", "confirmation"],
  "healingEvents": [],
  "modelCalls": 0,
  "paymentState": "completed",
  "cardLast4": "1111"
}
```

---

## Optional: Show the Leak Check (3:50–4:00)

**On screen:** Terminal

**Script:**
```bash
npm run leak-check
```

**Output:**
```
leak check passed: 243 file(s) in runs, heal-memory contain no card number or CVV
```

**Narration:**
"We also run the leak checker to prove no secrets ended up in the logs or screenshots. It scans every file, looks for card numbers, CVVs, and API keys, and reports success."

---

## Talking Points (for Q&A after video)

1. **"How does the agent know what to do?"**
   - It has 11 fixed steps. Each step has a postcondition. The runner picks the first step whose condition matches the current page, runs it, and verifies the postcondition before moving on.

2. **"What if the portal changes?"**
   - The healing ladder kicks in. First it waits, scrolls, or dismisses popups. Then it tries fallback locators (find by role instead of ID). If that fails, the model picks the right element from a list and the heal is saved. Next run, it reuses the heal without asking the model.

3. **"How is the card kept safe?"**
   - The payment executor is isolated. The model never has a reference to it. The card is in a vault file outside the repo. We read it just-in-time, use it, and wipe the reference. Every log is redacted for card numbers, CVVs, and API keys. After each run we scan all files with `npm run leak-check`.

4. **"Why does the agent reload the address/plan flow?"**
   - The portal's cart interaction is flaky. Sometimes clicks don't register, or the cart drops to zero. If the shop flow gets stuck after several retries, we reload the page and start the address/plan/router/orderNow steps again, up to 3 times.

5. **"What if the model is attacked (prompt injection)?"**
   - The agent detects injection text (e.g., "ignore previous instructions") on the page and logs it but doesn't send it to the model. And even if the model is tricked, it can't access the card—it only sees element roles and names, no input values.

---

## Recording Tips

- **Keep it quiet:** Terminal output scrolls fast. You may want to speed up the video or add captions for key lines.
- **Show the logs:** Let people see the step-by-step progress in the terminal.
- **Pause at payment:** Let the camera catch the 3-D Secure moment—it's the most interesting part.
- **End on the confirmation page:** Show the transaction ID clearly.
- **Keep it under 4 minutes:** Interviewers have limited time.

---

## What NOT to show

- Your `.env` file (contains API key)
- The vault file (`~/.nbn-agent/vault.json`)
- Your test card number anywhere
- The full API responses in the model-calls logs (just the file name is fine)

