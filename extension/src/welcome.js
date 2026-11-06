// Welcome page opened once on install (see background.js onInstalled).

const privacyLink = document.getElementById("privacy-link");
if (PREFLIGHT_CONFIG.WEBSITE_URL) {
  privacyLink.href = `${PREFLIGHT_CONFIG.WEBSITE_URL}privacy.html`;
  privacyLink.hidden = false;
}

document.getElementById("copy-btn").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(document.getElementById("sample-text").textContent);
    button.textContent = "Copied";
    button.classList.add("is-done");
  } catch (err) {
    button.textContent = "Select and copy";
  }
  setTimeout(() => {
    button.textContent = "Copy";
    button.classList.remove("is-done");
  }, 2000);
});
