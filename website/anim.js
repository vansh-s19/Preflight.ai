// Shared helpers for the site's scripted demos (hero and "How it works").
window.PreflightDemo = (function () {
  // Time only advances while the stage is on screen and the tab is visible,
  // so loops pause instead of burning CPU in the background. Timing is
  // wall-clock based, not per animation frame, so slow devices keep pace.
  function clock(stage) {
    let onScreen = true;
    new IntersectionObserver(([entry]) => { onScreen = entry.isIntersecting; }).observe(stage);

    return function sleep(ms) {
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
    };
  }

  // A fake mouse pointer that glides between elements inside the stage.
  function cursor(stage, el, sleep) {
    function pointAt(target, dx = 0, dy = 0) {
      const box = stage.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2 + dx, y: r.top - box.top + r.height / 2 + dy };
    }

    function place({ x, y }, instant = false) {
      if (instant) el.style.transition = "none";
      // The arrow's tip sits at (5, 3) in its 22px box.
      el.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
      if (instant) {
        el.getBoundingClientRect();
        el.style.transition = "";
      }
    }

    async function moveTo(target, dx, dy) {
      place(pointAt(target, dx, dy));
      await sleep(950);
    }

    async function click(target) {
      el.classList.add("is-clicking");
      target.classList.add("is-pressed");
      await sleep(140);
      target.classList.remove("is-pressed");
      await sleep(260);
      el.classList.remove("is-clicking");
    }

    return { pointAt, place, moveTo, click };
  }

  // Jump a transitioned style to a value without animating back to it.
  function snap(el, prop, value) {
    el.style.transition = "none";
    el.style[prop] = value;
    el.getBoundingClientRect();
    el.style.transition = "";
  }

  return { clock, cursor, snap };
})();
