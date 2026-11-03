// Hero demo: a looping "screen recording" of Preflight at work.
// Type a prompt -> click send -> Preflight warns -> click "Replace with
// Safe Data" -> values become placeholders -> send -> AI replies.
// The HTML holds a static fallback (the warning moment), which stays put
// when scripts are off or the visitor prefers reduced motion.
(function () {
  const demo = document.querySelector("[data-demo]");
  if (!demo) return;
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  const $ = (name) => demo.querySelector(`[data-demo-${name}]`);
  const chat = $("chat");
  const text = $("text");
  const send = $("send");
  const scrim = $("scrim");
  const card = $("card");
  const replace = $("replace");
  const toast = $("toast");
  const toastText = $("toast-text");
  const cursor = $("cursor");

  const PROMPT = [
    "Draft a payment reminder for our client. His PAN is ",
    { value: "ABCDE1234F", safe: "[SYNTHETIC_PAN]" },
    " and Account Number: ",
    { value: "50100234567890", safe: "[SYNTHETIC_BANK_ACCOUNT]" },
    ". Test it with our key ",
    { value: "sk-proj-a81F…kQ2", safe: "[REDACTED_OPENAI_KEY]" },
  ];
  const REPLY = "Here's a polite reminder you can send. I've kept the placeholders so you can fill in the real details yourself.";

  // Time only advances while the demo is on screen and the tab is visible,
  // so the loop pauses instead of burning CPU in the background. Timing is
  // wall-clock based, not per animation frame, so slow devices keep pace.
  let onScreen = true;
  new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(demo);

  function sleep(ms) {
    return new Promise((resolve) => {
      let elapsed = 0;
      let last = performance.now();
      (function tick() {
        const now = performance.now();
        if (onScreen && !document.hidden) elapsed += now - last;
        last = now;
        if (elapsed >= ms) resolve();
        else setTimeout(tick, Math.min(100, ms - elapsed));
      })();
    });
  }

  function pointAt(el, dx = 0, dy = 0) {
    const box = demo.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return { x: r.left - box.left + r.width / 2 + dx, y: r.top - box.top + r.height / 2 + dy };
  }

  function placeCursor({ x, y }, instant = false) {
    if (instant) cursor.style.transition = "none";
    // The arrow's tip sits at (5, 3) in its 22px box.
    cursor.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
    if (instant) {
      cursor.getBoundingClientRect();
      cursor.style.transition = "";
    }
  }

  async function moveTo(el, dx, dy) {
    placeCursor(pointAt(el, dx, dy));
    await sleep(950);
  }

  async function click(el) {
    cursor.classList.add("is-clicking");
    el.classList.add("is-pressed");
    await sleep(140);
    el.classList.remove("is-pressed");
    await sleep(260);
    cursor.classList.remove("is-clicking");
  }

  async function typePrompt() {
    text.classList.add("is-typing");
    for (const part of PROMPT) {
      let target;
      if (typeof part === "string") {
        target = document.createTextNode("");
        text.appendChild(target);
      } else {
        const mark = document.createElement("mark");
        mark.className = "token";
        mark.dataset.safe = part.safe;
        text.appendChild(mark);
        target = mark.appendChild(document.createTextNode(""));
      }
      const chars = typeof part === "string" ? part : part.value;
      for (const ch of chars) {
        target.data += ch;
        await sleep(ch === " " ? 22 : 14 + Math.random() * 20);
      }
    }
    text.classList.remove("is-typing");
  }

  function reset() {
    chat.replaceChildren();
    text.replaceChildren();
    scrim.classList.remove("is-on");
    card.classList.remove("is-open");
    toast.classList.remove("is-on");
    replace.classList.remove("is-hover");
    const box = demo.getBoundingClientRect();
    placeCursor({ x: box.width * 0.82, y: box.height * 0.62 }, true);
  }

  async function playOnce() {
    reset();
    await sleep(700);
    await typePrompt();
    await sleep(350);

    // Hit send. Preflight intercepts before anything leaves the browser.
    await moveTo(send);
    await click(send);
    text.querySelectorAll("mark").forEach((mark) => mark.classList.replace("token", "hit"));
    await sleep(300);
    scrim.classList.add("is-on");
    card.classList.add("is-open");
    await sleep(900);

    // Choose "Replace with Safe Data".
    await moveTo(replace, -30, 0);
    replace.classList.add("is-hover");
    await sleep(350);
    await click(replace);
    replace.classList.remove("is-hover");
    card.classList.remove("is-open");
    scrim.classList.remove("is-on");
    // Drift out of the way so the swap is easy to watch.
    placeCursor(pointAt(send, -70, -90));
    await sleep(350);

    // Each value fades out and its placeholder fades in.
    for (const mark of text.querySelectorAll("mark")) {
      mark.classList.add("is-swapping");
      await sleep(180);
      mark.textContent = mark.dataset.safe;
      mark.classList.replace("hit", "safe");
      mark.classList.remove("is-swapping");
      await sleep(240);
    }
    toastText.textContent = "3 items replaced with safe data";
    toast.classList.add("is-on");
    await sleep(1100);

    // Send the safe version.
    await moveTo(send);
    await click(send);
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble pop-in";
    bubble.append(...text.childNodes);
    chat.appendChild(bubble);
    toastText.textContent = "Sent safely";
    placeCursor(pointAt(demo.querySelector(".window-bar"), 120, 140));
    await sleep(700);

    // The AI still does the job.
    const reply = document.createElement("div");
    reply.className = "assistant-reply pop-in";
    reply.innerHTML = '<span class="assistant-avatar"></span><span class="typing-dots"><i></i><i></i><i></i></span>';
    chat.appendChild(reply);
    await sleep(1100);
    reply.lastElementChild.replaceWith(document.createTextNode(REPLY));
    toast.classList.remove("is-on");
    await sleep(3200);

    // Fade out before the next take instead of cutting.
    demo.classList.add("is-resetting");
    await sleep(450);
    reset();
    demo.classList.remove("is-resetting");
  }

  demo.classList.add("is-live");
  (async function loop() {
    for (;;) await playOnce();
  })();
})();
