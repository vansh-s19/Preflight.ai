(function () {
  const site = window.PREFLIGHT_SITE || {};

  document.querySelectorAll("[data-install]").forEach((link) => {
    if (site.chromeWebStoreUrl) {
      link.href = site.chromeWebStoreUrl;
      link.target = "_blank";
      link.rel = "noopener";
      return;
    }
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    link.classList.add("is-soon");
    const label = link.querySelector("[data-install-label]");
    if (label) label.textContent = link.hasAttribute("data-install-short") ? "Coming soon" : "Coming soon to Chrome";
  });

  document.querySelectorAll("[data-contact]").forEach((link) => {
    if (site.contactEmail) {
      link.href = `mailto:${site.contactEmail}`;
      if (link.hasAttribute("data-contact-show-email")) link.textContent = site.contactEmail;
      return;
    }
    if (link.hasAttribute("data-contact-fallback")) {
      link.replaceWith(document.createTextNode(link.getAttribute("data-contact-fallback")));
    } else if (link.hasAttribute("data-contact-soon")) {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
      link.classList.add("is-soon");
      link.textContent = "Coming soon";
    } else {
      link.hidden = true;
    }
  });

  const nav = document.querySelector(".nav");
  if (nav) {
    const update = () => nav.classList.toggle("is-scrolled", window.scrollY > 8);
    window.addEventListener("scroll", update, { passive: true });
    update();
  }

  document.querySelectorAll("[data-year]").forEach((node) => {
    node.textContent = String(new Date().getFullYear());
  });
})();
