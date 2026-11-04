# Chrome Web Store submission

Everything needed to fill in the Chrome Web Store developer dashboard for the
**Free** (personal-only) build. Copy each block into the matching field.

## Before you submit

1. `WEBSITE_URL` in `extension/src/config.js` is `https://preflightai.in/` (it
   drives the uninstall page, the "See plans" link and the welcome page's privacy
   link). If the domain changes, update it and rebuild.
2. `contactEmail` in `website/config.js` is `support@preflightai.in`; it shows
   on the privacy policy, Talk to us and the uninstall feedback buttons.
3. Run the checks in [qa-checklist.md](qa-checklist.md).
4. Build the package: `node scripts/build.mjs`. Upload `dist/preflight-ai-<version>.zip`.
   Build **without** `PREFLIGHT_API_URL`: the answers below are for a build that
   makes no network requests.

## Package

| Field | Value |
|---|---|
| Package | `dist/preflight-ai-1.0.0.zip` |
| Visibility | Public |
| Regions | All regions |
| Pricing | Free |

## Store listing

**Name** (from the manifest): `Preflight.ai`

**Summary** (from the manifest description, 124 of 132 characters):

```
Warns you before personal data, passwords, API keys or confidential info is sent to ChatGPT or Claude. Checks run on-device.
```

**Category:** Privacy & Security
**Language:** English

**Description:**

```
Pasted a PAN number, a customer's phone number or an API key into ChatGPT by mistake? Preflight.ai catches it before it's sent.

When you press send on ChatGPT or Claude, Preflight checks your message and any attached PDF, Word or text files. If it finds sensitive data, it pauses the send and shows you exactly what it found. You choose what happens next:

• Replace with safe data: sensitive values become clear placeholders like [SYNTHETIC_PAN], so the AI can still help.
• Send anyway: it's your call, and Preflight never blocks you.
• Go back and edit.

WHAT IT CATCHES
• Indian IDs and financial details: Aadhaar, PAN, GSTIN, bank account numbers, IFSC codes
• Phone numbers and email addresses
• API keys and secrets: OpenAI, Anthropic, AWS, JWTs, private keys, database connection strings, passwords and .env values
• Sensitive file types and source code pasted as text

PRIVATE BY DESIGN
• Every check runs inside your browser. The free version makes no network requests: nothing you type is sent to us or anyone else.
• No account, no sign-up, no analytics, no ads.
• It only runs on chatgpt.com, chat.openai.com and claude.ai.
• Its local history records what type of data was caught and when, never the text.

YOU STAY IN CONTROL
• Pause it for an hour, or switch it off on one site.
• Turn off any check you don't need.
• Mark a value "Not sensitive" and it won't warn you about it again.

FOR TEAMS
Preflight Enterprise adds private keyword lists for code names and clients, an admin dashboard with full history and exports, and AI checks for contracts and financial documents.

Preflight is a safety net, not a guarantee. It catches the common mistakes, so still take a look before you paste.
```

**Graphics** (in [assets/](assets/), regenerate with `node scripts/store-assets.mjs`):

| Field | File |
|---|---|
| Store icon (128×128) | `store-icon-128.png` |
| Screenshots (1280×800) | `screenshot-1-warning.png`, `screenshot-2-details.png`, `screenshot-3-replaced.png`, `screenshot-4-popup.png` |
| Small promo tile (440×280) | `promo-small-440x280.png` |

The screenshots show the extension's real warning and popup. The chat page behind
them is a plain, unbranded stand-in (`src/chat.html`), not ChatGPT or Claude.

**Links:**

| Field | Value |
|---|---|
| Official URL / Homepage | `https://preflightai.in/` |
| Support URL / email | `support@preflightai.in` |

## Privacy practices

**Single purpose:**

```
Preflight.ai warns users before sensitive personal data, credentials or confidential information is sent in a message or attachment to AI chat websites (ChatGPT and Claude), and lets them replace it with safe placeholders.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Saves the user's settings (on/off, pause, sites and checks switched off), hashed "not sensitive" values and a local history of detection types on the device. |
| `alarms` | Clears the toolbar "OFF" badge when a one-hour pause ends. |
| `activeTab` | When the user opens the popup, reads which supported AI site the current tab is on, so they can switch Preflight off for that site. |
| `scripting` | Injects the PDF and Word text readers, which are bundled in the extension, into the AI chat page only when the user attaches such a file, instead of loading them on every page. |
| Host permissions (`chatgpt.com`, `chat.openai.com`, `claude.ai`) | Runs the check on the message and attachments when the user presses send on these AI chat sites. The extension runs on no other sites. |

**Remote code:** No, I am not using remote code. (All JavaScript, including
pdf.js and mammoth, is bundled in the package.)

**Data usage:** for the Free build, check **no** data types. Prompt text and
attachments are read on the device to run the check and are never transmitted;
the build makes no network requests. Check all three certifications:

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

> If a later version ships Enterprise mode (a build with `PREFLIGHT_API_URL`),
> update this tab before publishing it: Enterprise sends **Website content**
> (message text for AI checks, when the organization's plan includes them) and
> **User activity** (detection types, actions, timing) to the organization's server.

**Privacy policy URL:** `https://preflightai.in/privacy.html`

## Notes for the reviewer

Paste into "Test instructions" (Distribution tab):

```
No account or login is needed.
1. Open https://chatgpt.com or https://claude.ai/new.
2. Type: My PAN is ABCDE1234F, call me on +91 9876543210
3. Press send. Preflight shows a "Sensitive Data Detected" warning before the message is sent.
4. Click "Replace with Safe Data" to swap the values for placeholders, or "Send Anyway".
Click the toolbar icon to pause Preflight, switch it off for the site, or choose which checks run.
```
