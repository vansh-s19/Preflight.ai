# Pre-submission test pass

Run in a normal Chrome profile with the store build loaded unpacked
(`node scripts/build.mjs`, then `chrome://extensions` → Developer mode →
Load unpacked → `dist/extension/`). Do every "Both sites" check on
**chatgpt.com** and **claude.ai**.

Sample text: `My PAN is ABCDE1234F, call me on +91 9876543210`

## Install

- [ ] Loading the extension opens the welcome page; its Copy button copies the sample.
- [ ] Reloading the extension (an update) does **not** open the welcome page again.
- [ ] `chrome://extensions` shows no errors for Preflight.

## Warning (both sites)

- [ ] Typing the sample and pressing **Enter** shows the warning; the message is not sent.
- [ ] Same with the **send button**.
- [ ] **Replace with Safe Data** puts `[SYNTHETIC_PAN]` and `[SYNTHETIC_PHONE]` in the box; sending that goes through with no warning.
- [ ] **Send Anyway** sends the original message once, with no second warning.
- [ ] **Close (×)**, **Escape** and clicking outside all cancel; the text stays in the box.
- [ ] A message with nothing sensitive sends with no delay you'd notice.

## Not sensitive (either site)

- [ ] View Details → "Not sensitive, don't warn again" on the PAN removes it from the warning; the counts update.
- [ ] Sending `PAN abcde1234f` afterwards gives no warning; `PAN ZZZZZ9999Z` still does.
- [ ] "Not sensitive? Send and don't warn me…" sends and stops both warnings next time.
- [ ] Popup → What Preflight checks → **Clear** brings the warnings back.

## Attachments (both sites)

- [ ] A PDF containing the sample warns on send.
- [ ] A DOCX containing the sample warns on send.
- [ ] A TXT containing the sample warns on send.
- [ ] A clean PDF sends without a warning.

## Popup

- [ ] Shows "Free · on-device", the weekly counts, and the Enterprise card; no charts, keyword box or exports.
- [ ] Switch off: badge shows **OFF**; the sample sends with no warning on both sites.
- [ ] Pause for 1 hour: badge shows **OFF**, button reads "Resume now"; Resume clears the badge.
- [ ] On claude.ai, untick "Check prompts on claude.ai": no warning there, still warns on ChatGPT.
- [ ] What Preflight checks → untick **Phone Number**: the sample only flags the PAN.
- [ ] See plans opens the website's pricing section.
- [ ] Clear history resets the counts.

## Page health

- [ ] On a normal chat page there is no **!** badge after 15 seconds.
- [ ] In DevTools, delete the message box element: within ~15 seconds the tab shows a red **!** and the popup explains it. Reload clears it.
- [ ] Settings pages (chatgpt.com/#settings, claude.ai/settings) never show **!**.

## Uninstall

- [ ] Removing the extension opens `https://preflightai.in/uninstall.html`.
