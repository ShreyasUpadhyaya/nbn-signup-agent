# Portal recon (14 Oct 2026)

Observed by driving the test portal with Playwright (headless Chromium, 1366x900) and by hand in Chrome.
Selectors are recorded as **hints**; the agent should locate by role and accessible name first.

## Cross-cutting behaviour

- **Slow portal.** First load is about 12 s; the address check takes about 17 s.
- **All popups are in the DOM at once.** A single `#user-model` dialog holds about 30 sub-popups; only one is visible at a time.
  Every locator must filter to visible elements, or it will match hidden duplicates (5 hidden "Build Your Plan" links exist).
- **"Heads up!" popup recurs.** It appears after the plan click *and again* on the connection page after choosing Transfer.
  It blocks pointer events until dismissed with its `Continue` link (`#a2g_back_btn`). Popup dismissal must be a generic
  step that runs on every page, not tied to one step.
- **Accessibility snapshot is good input for the model.** It contains only visible content, and buttons have
  meaningful accessible names.

## Phase A: address and plan (`/nbn/nbn-broadband#speeds`)

| Step | Locator (role / name first) | Legacy hint | Postcondition |
|---|---|---|---|
| Address box | textbox "Check your address to get started..." | `#autocomplete` (also a duplicate `#autocomplete-stickysearch` in the sticky bar) | Typed value reads back |
| Suggestions | `.autocomplete-suggestion` | | Appear about 1 s after typing (`/autosuggest` XHR) |
| Pick suggestion | suggestion text matching the normalised address | | **Typing a partial address returned DIANELLA first.** Match by normalised text, never blindly take the first |
| Address result | "Hold tight!" then "Result! Fibre to the Premises (FTTP)..." | `#address-success-days` | Visible link "Build Your Plan" (about 17 s) |
| Plan cards | heading "Value Plus" level 3; button "Choose Value Plus Plan" | `#3_speed`, `data-product-name="Value Plus"`, `data-product-price="59.90"` | Button accessible name becomes **"Value Plus has been selected"** |
| Cart total | button "Your total monthly cost is $X Amount to pay today: $Y. Order Now to proceed." | `#sticky-main-cart` | Accessible name contains a total above $0.00 |

Plan names on the portal: Value, Value Plus, Speedy Max, UltraSpeedy. The payload's `VALUE PLUS` matches case-insensitively.

**Silent no-op plan click reproduced naturally.** Across runs it took 1, 2 or 3 attempts. Pattern seen:
click, then "Heads up!" appears, then the button reverts to "Choose Plan" with the cart at $0.00. Working recovery: dismiss the popup,
re-check state, click again with a growing wait. Checking state (not the click) is essential.

## Phase B: router and cart

| Step | Locator | Postcondition |
|---|---|---|
| Router tabs | tablist "Add a router": tabs "Amazon eero 7", "NetComm", "Bring Your Own Router" | Tab `aria-selected=true` (the tab click sometimes needs a retry) |
| BYO option | button "Choose BYO Modem" inside tabpanel "Bring Your Own Router" | Button text reads "Selected"; cart stays at $59.90 |
| Order Now | button whose name contains "Order Now to proceed" | |
| BYO warning | dialog "Important: Looks like you're planning to use your own Wi-Fi router?" with links "Order Wi-Fi router" / **"Agree and Continue"** | URL moves to `/checkout/login` |

Payload `"BYO Modem"` maps to the tab "Bring Your Own Router" and the button "Choose BYO Modem".
The cart did not drop to $0.00 after choosing BYO in these runs.

## Phase C: checkout identity and contact

**Login** `/checkout/login`: `#login_email` + button "Next" (`#submit_email`).
- First runs with `prime150@yopmail.com` went straight to contact details.
- **After several runs the same email triggered an OTP**: `#otp_code` + button "Verify" (`#otp_submit`). That is the escalation case.
  For repeatable runs, use a fresh yopmail address per run.
- A hidden alternate login form also exists (`#email`, `#mobile_no`, `#account_otp`). It's not visible in the normal flow, so ignore it.

**Contact details** `/checkout/contact-details-view`:

| Field | Locator | Notes |
|---|---|---|
| Salutation | `#salutation` select | Options: Mr, Mrs, Miss, Dr, Ms, Mx |
| First / last name | `#fname`, `#lname` | maxlength 20 |
| Mobile | `#mobile` | `maxlength=10`, numeric, class `mobiledigits`. `0412345678` is accepted with plain fill. Spaces or `+61` get truncated |
| Date of birth | `#dob` | Input mask `'alias': 'date'`. Type digits `01021988` one at a time; it reads back `01/02/1988` |
| How did you hear | `#hear_about_us` | **No "Other" option; it is `--Other--`.** Needs normalised matching |
| Privacy | `#read_policy` checkbox | |
| Next | button "Next" | Validation errors render as BootstrapValidator help blocks |

No field wiping was observed on this page in headless runs.

**Service / billing address** `/checkout/address-view`: "Use Service Address" checkboxes (`#address1`, `#address2`) are
checked by default. "Self Care Portal" billing radio (`#print`, value `selfcareportaL`) is checked by default. Next is `#btn-address-transfer`.

## Phase D: connection details `/checkout/transfer-number-view`

| Field | Locator | Notes |
|---|---|---|
| Activation type | radios `name=new_or_transfer`: New = `100000000`, Transfer = `100000001` | **Radios have no accessible name.** Labels are adjacent text. Choosing Transfer triggers the "Heads up!" popup again |
| AVC ID | `#avc_id` + button "Check" | Shown after Transfer |
| Provide Later | radio `#avcidProvideLater`, label "Provide Later" | |
| Provider | `#new_or_transfer_provider` (label "NBN® PROVIDER *") | Includes Exetel |
| Connection date | `#conntectiondate` (sic) "Preferred Connection Date (Leave blank for ASAP)" | |
| NBN box question | radios `name=sq24`: `#radio-yes`, `#radio-no`, `#radio-unsure` | Choose Unsure |
| Submit | button "Process Order & Pay" (`#btn-transfer-number`) | URL moves to `/checkout/donate` |

## Phase E: donation and payment

**Donation** `/checkout/donate`: `#donate-no` radio, Next (`#btn-address-transfer`, the same ID as the address page).

**Payment** `/checkout/payment-view` (structure recorded before any typing; no screenshot taken):

| Field | Locator | Notes |
|---|---|---|
| Name on card | `#cardname` | Main frame |
| Card number | iframe `title="Card number"`, `https://secure.tillpayments.com/iframes/pan.html` | Parent `#number_div` |
| CVV | iframe `title="Card security code"`, `https://secure.tillpayments.com/iframes/cvv.html` | Parent `#cvv_div` |
| Expiry | `#expriy_month` (sic), label "CARD EXPIRY *" | Main frame, MM/YYYY |
| Card type | `#input_card_type` | Probably auto-filled |
| Consents | `#checkbox1`, `#checkbox29`, `#checkbox3`, `#checkbox7` | Tick all |
| Pay Now | `#till_pay_submit` | Opens a confirm modal (per the handout) |

**Other frames on the payment page**: ShareThis, The Trade Desk pixel, Comm100 chat, and **Google reCAPTCHA** (badge, probably invisible).
- The origin allow-list for card entry is exactly `https://secure.tillpayments.com`, and only the frames titled Card number / Card security code.
- **reCAPTCHA risk:** an invisible reCAPTCHA may challenge automated or headless browsers at Pay Now. Run headed for payment. A visible challenge means escalate (R7).

## After Pay Now (manual test payment, 14 Oct 2026)

- A confirm dialog appears after Pay Now (the handout says: tick both checkboxes, click its Pay Now). Treat it as optional.
- **3-D Secure is a challenge, shown on the same page** (not a new tab): "3-D Secure Verification / Choose Verification Result",
  a dropdown defaulting to **Authenticated (ECI 05)**, and a Submit button.
- Confirmation page: "You're done!" with "Your temporary Account Number" (7 digits, e.g. `3024051`) and
  **"Your Transaction Id"**, e.g. `1791996082tco`: 10-digit Unix timestamp in seconds plus 3 lowercase letters.
  Validation pattern: `^\d{10}[a-z]{3}$` (log a warning and accept `^\d{9,11}[a-z0-9]{2,5}$` if the format drifts).
