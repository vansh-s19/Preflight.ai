// "How it works" cards: each visual loops a short clip of its step. The HTML
// holds a static frame, which stays put when scripts are off or the visitor
// prefers reduced motion.
(function () {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const { clock, cursor, snap } = window.PreflightDemo;

  // Each clip gets its stage and sleep(), and returns reset() and play().
  const CLIPS = {
    // 1. Type a request, attach a file, ready to send.
    type(stage, sleep, $) {
      const text = $("text");
      const file = $("file");
      const progress = $("progress");
      const send = $("send");
      const words = text.textContent;
      return {
        reset() {
          text.textContent = "";
          file.classList.add("is-hidden");
          file.classList.remove("is-done");
          snap(progress, "width", "0%");
          send.classList.remove("is-ready");
        },
        async play() {
          await sleep(500);
          text.classList.add("is-typing");
          for (const ch of words) {
            text.textContent += ch;
            await sleep(ch === " " ? 45 : 30 + Math.random() * 35);
          }
          await sleep(350);
          file.classList.remove("is-hidden");
          await sleep(350);
          progress.style.width = "100%";
          await sleep(1000);
          file.classList.add("is-done");
          text.classList.remove("is-typing");
          send.classList.add("is-ready");
          await sleep(2400);
        },
      };
    },

    // 2. Scan bar sweeps; each check resolves, the last one flags.
    scan(stage, sleep, $) {
      const status = $("status");
      const bar = $("bar");
      const rows = stage.querySelectorAll("[data-how-row]");
      return {
        reset() {
          status.textContent = "Scanning…";
          status.classList.remove("is-flag");
          snap(bar, "width", "0%");
          rows.forEach((row) => row.classList.add("is-pending"));
        },
        async play() {
          await sleep(600);
          bar.style.width = "100%";
          for (const row of rows) {
            await sleep(480);
            row.classList.remove("is-pending");
          }
          await sleep(150);
          status.textContent = "1 issue found";
          status.classList.add("is-flag");
          await sleep(2800);
        },
      };
    },

    // 3. Pointer clicks "Replace with Safe Data"; the value becomes a placeholder.
    decide(stage, sleep, $) {
      const pointer = cursor(stage, $("cursor"), sleep);
      const replace = $("replace");
      const label = $("replace-label");
      const value = $("value");
      const original = value.textContent;
      return {
        reset() {
          replace.classList.remove("is-done", "is-hover");
          label.textContent = "Replace with Safe Data";
          value.textContent = original;
          value.className = "hit";
          pointer.place({ x: stage.clientWidth + 10, y: stage.clientHeight - 10 }, true);
        },
        async play() {
          await sleep(500);
          await pointer.moveTo(replace, -24, 2);
          replace.classList.add("is-hover");
          await sleep(300);
          await pointer.click(replace);
          replace.classList.remove("is-hover");
          replace.classList.add("is-done");
          label.textContent = "Replaced";
          value.classList.add("is-swapping");
          await sleep(180);
          value.textContent = "[SYNTHETIC_BANK_ACCOUNT]";
          value.className = "safe";
          pointer.place(pointer.pointAt(replace, 70, 46));
          await sleep(2600);
        },
      };
    },

    // 4. The safe prompt goes out and the AI answers anyway.
    reply(stage, sleep, $) {
      const bubble = $("bubble");
      const sent = $("sent");
      const reply = $("reply");
      const dots = $("dots");
      const replyText = $("reply-text");
      const answer = replyText.textContent.split(" ");
      return {
        reset() {
          [bubble, sent, reply].forEach((el) => el.classList.add("is-hidden"));
          dots.hidden = false;
          replyText.textContent = "";
        },
        async play() {
          await sleep(500);
          bubble.classList.remove("is-hidden");
          await sleep(500);
          sent.classList.remove("is-hidden");
          await sleep(600);
          reply.classList.remove("is-hidden");
          await sleep(1100);
          dots.hidden = true;
          for (const [i, word] of answer.entries()) {
            replyText.textContent += (i ? " " : "") + word;
            await sleep(70);
          }
          await sleep(2800);
        },
      };
    },
  };

  document.querySelectorAll("[data-how]").forEach((stage, index) => {
    const sleep = clock(stage);
    const $ = (name) => stage.querySelector(`[data-how-${name}]`);
    const clip = CLIPS[stage.dataset.how](stage, sleep, $);

    clip.reset();
    stage.classList.add("is-live");
    (async function loop() {
      // Stagger the first run so the cards play in step order.
      await sleep(index * 700);
      for (;;) {
        await clip.play();
        // Fade out before the next take instead of cutting.
        stage.classList.add("is-resetting");
        await sleep(400);
        clip.reset();
        stage.classList.remove("is-resetting");
      }
    })();
  });
})();
