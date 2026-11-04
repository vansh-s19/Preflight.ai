// Scrolling feel: Lenis eases the wheel into a soft glide, and each block
// fades up a little as it enters the screen. Both are skipped for visitors
// who prefer reduced motion, so the page scrolls and shows as normal.
(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const NAV_OFFSET = -72;

  if (window.Lenis) {
    const lenis = new Lenis({ lerp: 0.1, wheelMultiplier: 1 });
    requestAnimationFrame(function raf(time) {
      lenis.raf(time);
      requestAnimationFrame(raf);
    });

    // In-page links glide too, stopping just below the fixed nav.
    document.addEventListener("click", (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link) return;
      const id = link.getAttribute("href");
      const target = id === "#" || id === "#top" ? 0 : document.querySelector(id);
      if (target === null) return;
      event.preventDefault();
      lenis.scrollTo(target, { offset: target === 0 ? 0 : NAV_OFFSET });
      history.replaceState(null, "", id === "#" ? location.pathname : id);
    });
  }

  if (!("IntersectionObserver" in window)) return;

  // Siblings in the same row arrive one after another.
  const GROUPS = [
    ".catches-text",
    ".section-head",
    ".how-card",
    ".compare > *",
    ".bento-card",
    ".privacy-link",
    ".plan",
    ".faq details",
    ".final-inner",
  ];
  const items = document.querySelectorAll(GROUPS.join(","));
  const order = new Map();
  items.forEach((el) => {
    const index = order.get(el.parentNode) || 0;
    order.set(el.parentNode, index + 1);
    el.style.setProperty("--reveal-delay", `${Math.min(index, 4) * 90}ms`);
    el.setAttribute("data-reveal", "");
  });
  document.documentElement.classList.add("js-reveal");

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const el = entry.target;
        observer.unobserve(el);
        el.classList.add("is-in");
        // Hand hover effects back their own timing once the entrance is done.
        // Demos inside a card run transitions of their own, so match on el.
        el.addEventListener("transitionend", function done(event) {
          if (event.target !== el || event.propertyName !== "transform") return;
          el.removeEventListener("transitionend", done);
          el.removeAttribute("data-reveal");
          el.classList.remove("is-in");
          el.style.removeProperty("--reveal-delay");
        });
      });
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
  );
  items.forEach((el) => observer.observe(el));
})();
