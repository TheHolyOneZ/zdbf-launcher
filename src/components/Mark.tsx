import { type Ref, useEffect, useImperativeHandle, useRef } from "react";
import type { Tone } from "../lib/format";
import { gsap, onSignal, reduced } from "../lib/motion";

const HEX = "M50 4 L90 27 L90 73 L50 96 L10 73 L10 27 Z";
const Z = "M26 31 H70 L34 69 H74";
const TRACE_A = "M34 39 H56 L60 35";
const TRACE_B = "M44 61 H66 L70 57";
const ROUTES = [Z, TRACE_A, TRACE_B, Z];
const NODES: Array<[number, number]> = [
  [26, 31],
  [59.3, 42.8],
  [44.7, 57.2],
  [74, 69],
];
const RING_R = 58;
const RING_C = 2 * Math.PI * RING_R;

export function Mark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path d={HEX} fill="var(--deck-2)" stroke="var(--signal)" strokeWidth="6" strokeLinejoin="round" />
      <path
        d={Z}
        fill="none"
        stroke="var(--signal)"
        strokeWidth="9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {NODES.map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="5.5" fill="var(--signal-2)" />
      ))}
    </svg>
  );
}

export interface CoreHandle {
  beat: () => void;
  packet: (tone: Tone) => void;
  element: () => SVGSVGElement | null;
}

export type RingMode = "uptime" | "countdown" | "spin" | "none";

export function Core({
  tone,
  size = 300,
  ring = 0,
  ringMode = "none",
  stage,
  handle,
  listen,
}: {
  tone: Tone;
  size?: number;
  ring?: number;
  ringMode?: RingMode;
  stage?: number;
  handle?: Ref<CoreHandle>;
  listen?: boolean;
}) {
  const root = useRef<SVGSVGElement>(null);
  const previous = useRef<string | null>(null);
  const lastPacket = useRef(0);
  const lastBeat = useRef(0);
  const api = useRef<CoreHandle | null>(null);

  useImperativeHandle(handle, () => api.current as CoreHandle, []);

  useEffect(() => {
    if (!listen) return;
    return onSignal((s) => {
      const now = performance.now();
      api.current?.packet(s.tone);
      if (now - lastBeat.current > 380) {
        lastBeat.current = now;
        api.current?.beat();
        const orbit = root.current?.querySelector(".core-orbit");
        if (orbit && !reduced()) {
          gsap.to(orbit, {
            rotation: `+=${14 + s.strength * 22}`,
            svgOrigin: "50 50",
            duration: 1.4,
            ease: "signal",
          });
        }
      }
    });
  }, [listen]);

  if (!api.current)
    api.current = {
      element: () => root.current,
      beat: () => {
        const el = root.current;
        if (!el || reduced()) return;
        const hex = el.querySelector(".core-hex");
        const halo = el.querySelector(".core-halo");
        const nodes = el.querySelectorAll(".core-node");
        gsap.fromTo(
          hex,
          { scale: 1.035 },
          { scale: 1, duration: 0.7, ease: "elastic.out(1, 0.45)", transformOrigin: "50% 50%" },
        );
        gsap.fromTo(
          halo,
          { scale: 0.92, opacity: 0.55 },
          { scale: 1.32, opacity: 0, duration: 1.2, ease: "drift", transformOrigin: "50% 50%" },
        );
        gsap.fromTo(
          nodes,
          { scale: 1.45 },
          { scale: 1, duration: 0.5, stagger: 0.05, ease: "power3.out", transformOrigin: "50% 50%" },
        );
      },
      packet: (t: Tone) => {
        const el = root.current;
        if (!el || reduced()) return;
        const now = performance.now();
        if (now - lastPacket.current < 220) return;
        lastPacket.current = now;
        const layer = el.querySelector(".core-packets");
        if (!layer) return;
        const d = ROUTES[Math.floor(Math.random() * ROUTES.length)] ?? Z;
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", d);
        p.setAttribute("class", `core-packet packet-${t}`);
        layer.appendChild(p);
        const len = p.getTotalLength();
        const seg = Math.min(14, len * 0.4);
        p.style.strokeDasharray = `${seg} ${len + seg}`;
        const dur = 0.5 + len / 160;
        gsap.fromTo(
          p,
          { strokeDashoffset: seg, opacity: 1 },
          { strokeDashoffset: -len, duration: dur, ease: "power2.inOut", onComplete: () => p.remove() },
        );
        window.setTimeout(() => p.remove(), dur * 1000 + 400);
      },
    };

  const lit = stage !== undefined ? stage >= 4 : tone === "ok" || tone === "warn" || tone === "busy";
  const key = stage !== undefined ? `stage-${stage}` : lit ? `lit-${tone}` : `dark-${tone}`;

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const zPath = el.querySelector<SVGPathElement>(".core-z");
    const traces = [...el.querySelectorAll<SVGPathElement>(".core-trace")];
    const nodes = [...el.querySelectorAll<SVGCircleElement>(".core-node")];
    const hex = el.querySelector<SVGPathElement>(".core-hex-line");
    const first = previous.current === null;
    const prevKey = previous.current;
    previous.current = key;
    const all = [zPath, ...traces].filter((x): x is SVGPathElement => !!x);
    const hexLen = hex?.getTotalLength() ?? 0;
    for (const t of all) t.style.strokeDasharray = `${t.getTotalLength()}`;
    if (hex) hex.style.strokeDasharray = `${hexLen}`;

    const show = {
      hex: stage === undefined ? true : stage >= 1,
      z: stage === undefined ? lit : stage >= 2,
      traces: stage === undefined ? lit : stage >= 3,
      nodes: stage === undefined ? lit : stage >= 4,
    };

    gsap.killTweensOf([...all, ...nodes, hex, el]);
    if (reduced() || (first && stage === undefined)) {
      if (hex) hex.style.strokeDashoffset = show.hex ? "0" : `${hexLen}`;
      if (zPath) zPath.style.strokeDashoffset = show.z ? "0" : `${zPath.getTotalLength()}`;
      for (const t of traces) t.style.strokeDashoffset = show.traces ? "0" : `${t.getTotalLength()}`;
      for (const n of nodes) {
        n.style.opacity = show.nodes ? "1" : "0.2";
      }
      return;
    }

    const tl = gsap.timeline();
    if (hex) {
      tl.to(hex, { strokeDashoffset: show.hex ? 0 : hexLen, duration: 1.2, ease: "drift" }, 0);
    }
    if (zPath) {
      tl.to(
        zPath,
        {
          strokeDashoffset: show.z ? 0 : zPath.getTotalLength(),
          duration: show.z ? 0.95 : 0.6,
          ease: show.z ? "expo.out" : "power2.in",
        },
        show.z ? 0.15 : 0,
      );
    }
    traces.forEach((t, i) => {
      tl.to(
        t,
        {
          strokeDashoffset: show.traces ? 0 : t.getTotalLength(),
          duration: show.traces ? 0.8 : 0.5,
          ease: show.traces ? "power3.out" : "power2.in",
        },
        show.traces ? 0.45 + i * 0.12 : 0,
      );
    });
    tl.to(
      nodes,
      {
        opacity: show.nodes ? 1 : 0.2,
        scale: show.nodes ? 1 : 0.8,
        duration: 0.4,
        stagger: show.nodes ? 0.08 : 0,
        ease: show.nodes ? "back.out(3)" : "power2.in",
        transformOrigin: "50% 50%",
      },
      show.nodes ? 0.6 : 0,
    );

    if (tone === "bad" && prevKey !== null && !prevKey.startsWith("dark-bad")) {
      tl.fromTo(el, { x: -6 }, { x: 0, duration: 0.5, ease: "elastic.out(1.2, 0.2)", clearProps: "x" }, 0);
    }
  }, [key, lit, stage, tone]);

  useEffect(() => {
    const el = root.current;
    if (!el || tone !== "busy" || reduced()) return;
    const nodes = el.querySelectorAll(".core-node");
    const tween = gsap.to(nodes, {
      opacity: 0.35,
      duration: 0.6,
      repeat: -1,
      yoyo: true,
      stagger: { each: 0.15, repeat: -1, yoyo: true },
      ease: "sine.inOut",
      delay: 0.9,
    });
    return () => {
      tween.kill();
      gsap.set(nodes, { opacity: lit ? 1 : 0.2 });
    };
  }, [tone, lit]);

  const ringValue = Math.max(0, Math.min(1, ring));

  return (
    <svg
      ref={root}
      className={`core tone-${tone} ring-${ringMode}`}
      width={size}
      height={size}
      viewBox="-20 -20 140 140"
      aria-hidden
    >
      <circle className="core-halo" cx="50" cy="50" r="46" />
      <g className="core-orbit">
        <circle className="core-orbit-a" cx="50" cy="50" r="66" />
        <circle className="core-orbit-b" cx="50" cy="50" r="63" />
      </g>
      <circle className="core-ring-track" cx="50" cy="50" r={RING_R} />
      {ringMode !== "none" ? (
        <circle
          className="core-ring"
          cx="50"
          cy="50"
          r={RING_R}
          strokeDasharray={ringMode === "spin" ? `${RING_C * 0.18} ${RING_C}` : RING_C}
          strokeDashoffset={ringMode === "spin" ? 0 : RING_C * (1 - ringValue)}
          transform="rotate(-90 50 50)"
        />
      ) : null}
      <g className="core-ticks">
        {Array.from({ length: 60 }, (_, i) => {
          const a = (i / 60) * Math.PI * 2;
          const long = i % 5 === 0;
          const r1 = long ? 52.5 : 54;
          return (
            <line
              key={`t${a}`}
              x1={50 + Math.cos(a) * r1}
              y1={50 + Math.sin(a) * r1}
              x2={50 + Math.cos(a) * 55.5}
              y2={50 + Math.sin(a) * 55.5}
              className={long ? "tick tick-long" : "tick"}
            />
          );
        })}
      </g>
      <g className="core-hex">
        <path className="core-hex-fill" d={HEX} />
        <path className="core-hex-line" d={HEX} />
        <path className="core-z-base" d={Z} />
        <path className="core-trace-base" d={TRACE_A} />
        <path className="core-trace-base" d={TRACE_B} />
        <path className="core-z" d={Z} />
        <path className="core-trace" d={TRACE_A} />
        <path className="core-trace" d={TRACE_B} />
        <g className="core-packets" />
        {NODES.map(([x, y]) => (
          <circle key={`${x}-${y}`} className="core-node" cx={x} cy={y} r="4.2" />
        ))}
      </g>
    </svg>
  );
}
