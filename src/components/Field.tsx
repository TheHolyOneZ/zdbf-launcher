import { useEffect, useRef } from "react";
import type { Tone } from "../lib/format";
import { cssVar, onBeat, reduced, TONE_COLOR } from "../lib/motion";

const GAP = 28;
const ROW = GAP * 0.866;
const REACH = 200;
const WAVE_LIFE = 1.7;

interface Wave {
  x: number;
  y: number;
  born: number;
  strength: number;
}

export function Field({ tone }: { tone: Tone }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const toneRef = useRef(tone);
  toneRef.current = tone;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;
    const lattice = document.createElement("canvas");
    const lctx = lattice.getContext("2d");
    if (!lctx) return;

    let w = 0;
    let h = 0;
    let ox = 0;
    let oy = 0;
    let raf = 0;
    let last = 0;
    let dots: Float32Array = new Float32Array(0);
    const pointer = { x: -9999, y: -9999, seen: 0 };
    const waves: Wave[] = [];
    const colors = { signal: "", tone: "", ink: "" };

    const readColors = () => {
      colors.signal = cssVar("--signal");
      colors.ink = cssVar("--ink-3");
      colors.tone = cssVar(TONE_COLOR[toneRef.current]);
    };

    const fadeAt = (y: number) => (y < h * 0.45 ? 1 : Math.max(0, 1 - (y - h * 0.45) / (h * 0.55)));

    const paintLattice = () => {
      lctx.clearRect(0, 0, w, h);
      const t = toneRef.current;
      const live = t === "ok" || t === "warn";
      lctx.fillStyle = live || t === "busy" ? colors.signal : colors.ink;
      const base = live ? 0.16 : t === "bad" ? 0.12 : 0.11;
      for (let i = 0; i < dots.length; i += 3) {
        lctx.globalAlpha = base * (dots[i + 2] ?? 0);
        lctx.fillRect((dots[i] ?? 0) - 0.65, (dots[i + 1] ?? 0) - 0.65, 1.3, 1.3);
      }
      lctx.globalAlpha = 1;
    };

    const build = () => {
      const r = el.getBoundingClientRect();
      ox = r.left;
      oy = r.top;
      w = Math.max(1, Math.round(r.width));
      h = Math.max(1, Math.round(r.height));
      el.width = w;
      el.height = h;
      lattice.width = w;
      lattice.height = h;
      const list: number[] = [];
      for (let row = 0, y = ROW / 2; y < h; row++, y += ROW) {
        const f = fadeAt(y);
        if (f < 0.03) continue;
        for (let x = row & 1 ? GAP / 2 : 0; x < w + GAP; x += GAP) list.push(x, y, f);
      }
      dots = new Float32Array(list);
      paintLattice();
    };

    const active = (now: number) =>
      now - pointer.seen < 900 || waves.length > 0 || toneRef.current === "busy";

    const draw = (now: number) => {
      ctx.clearRect(0, 0, w, h);
      ctx.drawImage(lattice, 0, 0);
      for (let i = waves.length - 1; i >= 0; i--) {
        const wv = waves[i];
        if (wv && (now - wv.born) / 1000 > WAVE_LIFE) waves.splice(i, 1);
      }
      const px = pointer.x - ox;
      const py = pointer.y - oy;
      const near = now - pointer.seen < 900;
      const busy = toneRef.current === "busy";
      const sweep = busy ? ((now / 1600) % 1) * (w + 400) - 200 : -1e9;
      if (!near && !waves.length && !busy) return;

      const glow = new Path2D();
      const ring = new Path2D();
      for (let i = 0; i < dots.length; i += 3) {
        const x = dots[i] ?? 0;
        const y = dots[i + 1] ?? 0;
        const f = dots[i + 2] ?? 0;
        let a = 0;
        if (near) {
          const d = Math.hypot(x - px, y - py);
          if (d < REACH) a += (1 - d / REACH) ** 2;
        }
        if (busy) {
          const s = Math.abs(x + y * 0.35 - sweep);
          if (s < 110) a += (1 - s / 110) * 0.6;
        }
        let wa = 0;
        for (const wv of waves) {
          const age = (now - wv.born) / 1000;
          const band = Math.abs(Math.hypot(x - (wv.x - ox), y - (wv.y - oy)) - age * 480);
          if (band < 44) wa += (1 - band / 44) * (1 - age / WAVE_LIFE) * wv.strength;
        }
        a *= f;
        wa *= f;
        if (wa > 0.05) {
          const s = 1.6 + Math.min(1.8, wa * 2.4);
          ring.rect(x - s / 2, y - s / 2, s, s);
        } else if (a > 0.05) {
          const s = 1.4 + Math.min(1.6, a * 2);
          glow.rect(x - s / 2, y - s / 2, s, s);
        }
      }
      ctx.fillStyle = colors.signal;
      ctx.globalAlpha = 0.55;
      ctx.fill(glow);
      ctx.fillStyle = colors.tone;
      ctx.globalAlpha = 0.85;
      ctx.fill(ring);
      ctx.globalAlpha = 1;
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < (document.hasFocus() ? 33 : 120)) return;
      last = now;
      draw(now);
      if (!active(now)) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    };

    const wake = () => {
      if (raf || document.hidden || reduced()) return;
      raf = requestAnimationFrame(loop);
    };

    const repaint = () => {
      readColors();
      paintLattice();
      if (!raf) draw(performance.now());
      wake();
    };

    const move = (e: PointerEvent) => {
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.seen = performance.now();
      wake();
    };
    const leave = () => {
      pointer.seen = 0;
    };
    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else wake();
    };
    const offBeat = onBeat((b) => {
      if (reduced()) return;
      waves.push({ x: b.x, y: b.y, born: performance.now(), strength: b.strength });
      if (waves.length > 5) waves.shift();
      wake();
    });

    readColors();
    build();
    draw(performance.now());
    const ro = new ResizeObserver(() => {
      build();
      draw(performance.now());
    });
    ro.observe(el);
    el.addEventListener("tone", repaint);
    const themeWatch = new MutationObserver(repaint);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    window.addEventListener("pointermove", move, { passive: true });
    document.addEventListener("pointerleave", leave);
    document.addEventListener("visibilitychange", visibility);
    wake();

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeWatch.disconnect();
      offBeat();
      el.removeEventListener("tone", repaint);
      window.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", leave);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    el.dataset.tone = tone;
    el.dispatchEvent(new Event("tone"));
  }, [tone]);

  return <canvas ref={canvas} className="signal-field" aria-hidden />;
}
