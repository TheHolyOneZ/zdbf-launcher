import { useEffect, useRef } from "react";
import type { Tone } from "../lib/format";
import { cssVar, onSignal, reduced, TONE_COLOR } from "../lib/motion";

interface Carrier {
  amp: number;
  period: number;
  noise: number;
  speed: number;
}

const CARRIER: Record<Tone, Carrier> = {
  ok: { amp: 0.05, period: 2.4, noise: 0.012, speed: 120 },
  warn: { amp: 0.07, period: 1.6, noise: 0.04, speed: 120 },
  busy: { amp: 0.14, period: 0.5, noise: 0.05, speed: 170 },
  bad: { amp: 0, period: 1, noise: 0.006, speed: 90 },
  idle: { amp: 0, period: 1, noise: 0, speed: 90 },
};

const SPIKE = [0.15, 0.55, 1, 0.62, -0.34, -0.22, -0.08, 0.04];
const SHADES: Tone[] = ["ok", "warn", "bad", "busy", "idle"];

export function Pulse({
  tone,
  height = 96,
  className,
  fade,
}: {
  tone: Tone;
  height?: number;
  className?: string;
  fade?: [number, number];
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const toneRef = useRef(tone);
  const fadeRef = useRef(fade);
  toneRef.current = tone;
  fadeRef.current = fade;

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let raf = 0;
    let buf = new Float32Array(0);
    let shade = new Uint8Array(0);
    let head = 0;
    let phase = 0;
    let last = performance.now();
    let amp = 0;
    let flare = 0;
    let burst = 0;
    let settled = 0;
    const queue: Array<{ k: number; strength: number; shade: number }> = [];
    const colors = new Map<number, string>();
    let base = "";

    const readColors = () => {
      base = cssVar(TONE_COLOR[toneRef.current]);
      SHADES.forEach((t, i) => {
        colors.set(i, cssVar(TONE_COLOR[t]));
      });
    };

    const resize = () => {
      const r = el.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      w = Math.max(1, Math.round(r.width));
      h = r.height;
      el.width = Math.round(w * dpr);
      el.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const next = new Float32Array(w);
      next.set(buf.subarray(0, Math.min(buf.length, w)));
      buf = next;
      const nextShade = new Uint8Array(w);
      nextShade.set(shade.subarray(0, Math.min(shade.length, w)));
      shade = nextShade;
      head = Math.min(head, w - 1);
    };

    const live = () => {
      const t = toneRef.current;
      return t === "ok" || t === "warn" || t === "busy" || burst > 0 || queue.length > 0 || flare > 0;
    };

    const step = (dt: number) => {
      const t = toneRef.current;
      const c = CARRIER[t];
      amp += (c.amp - amp) * Math.min(1, dt * 3);
      const steps = Math.max(1, Math.round(c.speed * dt));
      for (let i = 0; i < steps; i++) {
        phase += dt / c.period / steps;
        let v = Math.sin(phase * Math.PI * 2) * amp + (Math.random() - 0.5) * c.noise;
        let s = SHADES.indexOf(t);
        if (burst > 0) {
          v += (Math.random() - 0.5) * 1.1 * Math.min(1, burst * 3);
          s = 2;
          burst = Math.max(0, burst - dt / steps);
        }
        const q = queue[0];
        if (q) {
          v += (SPIKE[q.k] ?? 0) * q.strength;
          s = q.shade;
          q.k += 1;
          if (q.k >= SPIKE.length) queue.shift();
        }
        head = (head + 1) % w;
        buf[head] = v;
        shade[head] = s;
      }
      flare = Math.max(0, flare - dt * 2);
    };

    const draw = () => {
      ctx.clearRect(0, 0, w, h);
      const mid = h * 0.6;
      const scale = h * 0.44;
      const gap = 22;
      const seg = 14;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      const own = SHADES.indexOf(toneRef.current);

      for (let pass = 0; pass < 2; pass++) {
        ctx.lineWidth = pass === 0 ? 6 : 1.6;
        for (let s0 = 0; s0 < w; s0 += seg) {
          const alpha = (1 - s0 / w) ** 1.5;
          if (alpha < 0.02) break;
          const first = (head - s0 + w) % w;
          const sh = shade[first] ?? own;
          ctx.strokeStyle = sh === own ? base : (colors.get(sh) ?? base);
          ctx.globalAlpha = pass === 0 ? alpha * (0.06 + flare * 0.1) : alpha;
          ctx.beginPath();
          let moved = false;
          for (let k = 0; k <= seg; k++) {
            const back = s0 + k;
            if (back >= w - gap) break;
            const i = (head - back + w) % w;
            const y = mid - (buf[i] ?? 0) * scale;
            if (!moved || i === w - 1) {
              ctx.moveTo(i, y);
              moved = true;
            } else ctx.lineTo(i, y);
          }
          ctx.stroke();
        }
      }

      if (live()) {
        const hy = mid - (buf[head] ?? 0) * scale;
        ctx.fillStyle = base;
        ctx.globalAlpha = 0.16 + flare * 0.3;
        ctx.beginPath();
        ctx.arc(head, hy, 8 + flare * 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.beginPath();
        ctx.arc(head, hy, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      const f = fadeRef.current;
      if (f) {
        const grad = ctx.createLinearGradient(0, 0, w, 0);
        grad.addColorStop(0, "rgba(0,0,0,0)");
        grad.addColorStop(f[0], "rgba(0,0,0,1)");
        grad.addColorStop(f[1], "rgba(0,0,0,1)");
        grad.addColorStop(1, "rgba(0,0,0,0)");
        ctx.globalCompositeOperation = "destination-in";
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, w, h);
        ctx.globalCompositeOperation = "source-over";
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const budget = document.hasFocus() ? 33 : 100;
      if (now - last < budget) return;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      step(dt);
      draw();
      if (live()) settled = 0;
      else {
        settled += dt;
        if (settled > (w / CARRIER[toneRef.current].speed) * 1.1) {
          cancelAnimationFrame(raf);
          raf = 0;
        }
      }
    };

    const wake = () => {
      if (raf || document.hidden || reduced()) return;
      last = performance.now();
      settled = 0;
      raf = requestAnimationFrame(loop);
    };

    const start = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      readColors();
      resize();
      if (reduced()) {
        draw();
        return;
      }
      wake();
    };

    const onTone = () => {
      const prev = el.dataset.prev;
      readColors();
      if (toneRef.current === "bad" && prev && prev !== "bad") burst = 0.4;
      el.dataset.prev = toneRef.current;
      wake();
    };

    const offSignal = onSignal((sig) => {
      if (reduced() || queue.length > 6) return;
      queue.push({ k: 0, strength: 0.35 + sig.strength * 0.6, shade: SHADES.indexOf(sig.tone) });
      flare = 1;
      wake();
    });

    const visibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(raf);
        raf = 0;
      } else wake();
    };

    el.dataset.prev = toneRef.current;
    el.addEventListener("tone", onTone);
    const ro = new ResizeObserver(() => {
      resize();
      if (!raf) draw();
    });
    ro.observe(el);
    const themeWatch = new MutationObserver(() => {
      readColors();
      if (!raf) draw();
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", visibility);
    start();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      themeWatch.disconnect();
      offSignal();
      el.removeEventListener("tone", onTone);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    el.dataset.tone = tone;
    el.dispatchEvent(new Event("tone"));
  }, [tone]);

  return (
    <canvas
      ref={canvas}
      className={`pulse${className ? ` ${className}` : ""}`}
      style={{ height }}
      aria-hidden
    />
  );
}
