import {
  type CSSProperties,
  type ElementType,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { gsap, reduced, SplitText } from "../lib/motion";

export function Stage({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || reduced()) return;
    const ctx = gsap.context(() => {
      const items = el.querySelectorAll<HTMLElement>(
        "[data-reveal], .page-lead, .page-actions, .section, .update-card, .ext, .callout, .backup-list li, .dash-steps > li, .subnav, .launcher-row, .about-group, .about-card",
      );
      const tl = gsap.timeline();
      tl.fromTo(el, { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.32, ease: "signal" });
      if (items.length) {
        tl.fromTo(
          items,
          { opacity: 0, y: 16 },
          {
            opacity: 1,
            y: 0,
            duration: 0.5,
            stagger: { each: 0.035, amount: 0.28 },
            ease: "signal",
            clearProps: "transform,opacity",
          },
          0.02,
        );
      }
      const lines = el.querySelectorAll<HTMLElement>("[data-draw]");
      if (lines.length) {
        tl.fromTo(
          lines,
          { scaleX: 0, transformOrigin: "0 50%" },
          { scaleX: 1, duration: 1.1, stagger: 0.08, ease: "drift", clearProps: "transform" },
          0.1,
        );
      }
    }, el);
    return () => ctx.revert();
  }, []);
  return (
    <div ref={ref} className={`stage${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

export function RollText({
  text,
  as: Tag = "span",
  className,
  stretch,
}: {
  text: string;
  as?: ElementType;
  className?: string;
  stretch?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.textContent = text;
    if (reduced()) return;
    let split: SplitText | null = null;
    const ctx = gsap.context(() => {
      split = SplitText.create(el, { type: "chars", mask: "chars", charsClass: "roll-char" });
      const tl = gsap.timeline();
      tl.fromTo(
        split.chars,
        { yPercent: 115, rotate: 6 },
        { yPercent: 0, rotate: 0, duration: 0.8, stagger: 0.032, ease: "signal" },
      );
      if (stretch) {
        tl.fromTo(
          el,
          { fontVariationSettings: "'wdth' 100" },
          { fontVariationSettings: "'wdth' 125", duration: 1.1, ease: "drift" },
          0,
        );
      }
      tl.call(() => {
        split?.revert();
        el.style.removeProperty("font-variation-settings");
      });
    }, el);
    return () => {
      ctx.revert();
      split?.revert();
    };
  }, [text, stretch]);
  return <Tag ref={ref} className={className} aria-label={text} />;
}

export function Scramble({ text, className }: { text: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (first.current || reduced()) {
      first.current = false;
      el.textContent = text;
      return;
    }
    const tween = gsap.to(el, {
      duration: 0.45,
      scrambleText: { text, chars: "ZDBF01", speed: 0.8, revealDelay: 0.1 },
      ease: "none",
      onComplete: () => {
        el.textContent = text;
      },
    });
    return () => {
      tween.kill();
      el.textContent = text;
    };
  }, [text]);
  return <span ref={ref} className={className} />;
}

export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  className,
}: {
  value: number;
  format?: (n: number) => string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const shown = useRef(0);
  const fmt = useRef(format);
  fmt.current = format;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced()) {
      shown.current = value;
      el.textContent = fmt.current(value);
      return;
    }
    const obj = { v: shown.current };
    const tween = gsap.to(obj, {
      v: value,
      duration: 1.2,
      ease: "signal",
      onUpdate: () => {
        shown.current = obj.v;
        el.textContent = fmt.current(obj.v);
      },
    });
    return () => {
      tween.kill();
    };
  }, [value]);
  return <span ref={ref} className={className} />;
}

export function Digits({ text, className }: { text: string; className?: string }) {
  return (
    <span className={`digits${className ? ` ${className}` : ""}`}>
      <span className="visually-hidden">{text}</span>
      {text.split("").map((ch, i) => (
        <Digit key={`${text.length - i}`} ch={ch} />
      ))}
    </span>
  );
}

function Digit({ ch }: { ch: string }) {
  const [pair, setPair] = useState<{ cur: string; prev: string | null; n: number }>({
    cur: ch,
    prev: null,
    n: 0,
  });
  if (pair.cur !== ch) setPair({ cur: ch, prev: pair.cur, n: pair.n + 1 });
  const digit = /\d/.test(ch);
  return (
    <span className={`digit${digit ? "" : " digit-sep"}`} aria-hidden>
      {pair.prev !== null && !reduced() ? (
        <span key={`o${pair.n}`} className="digit-out">
          {pair.prev}
        </span>
      ) : null}
      <span key={`i${pair.n}`} className={pair.n > 0 && !reduced() ? "digit-in" : undefined}>
        {pair.cur}
      </span>
    </span>
  );
}

export function useSpotlight() {
  useEffect(() => {
    let raf = 0;
    let target: HTMLElement | null = null;
    let x = 0;
    let y = 0;
    const apply = () => {
      raf = 0;
      if (!target) return;
      const r = target.getBoundingClientRect();
      target.style.setProperty("--mx", `${x - r.left}px`);
      target.style.setProperty("--my", `${y - r.top}px`);
    };
    const move = (e: PointerEvent) => {
      const el = (e.target as HTMLElement | null)?.closest<HTMLElement>(".spot") ?? null;
      if (el !== target) {
        target?.classList.remove("is-lit");
        target = el;
        target?.classList.add("is-lit");
      }
      x = e.clientX;
      y = e.clientY;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener("pointermove", move, { passive: true });
    return () => {
      window.removeEventListener("pointermove", move);
      cancelAnimationFrame(raf);
    };
  }, []);
}

export function Ring({
  value,
  size = 44,
  stroke = 3,
  tone = "signal",
  style,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: string;
  style?: CSSProperties;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg
      className="ring"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={style}
      aria-hidden
    >
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-track" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        className={`ring-fill ring-${tone}`}
        strokeWidth={stroke}
        strokeDasharray={c}
        strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

export function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(t);
  }, [ms]);
  return now;
}

export function SegThumb() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    const box = el?.parentElement;
    if (!el || !box) return;
    let placed = false;
    const place = () => {
      const on = box.querySelector<HTMLElement>('[aria-checked="true"], [aria-selected="true"]');
      if (!on) {
        el.style.opacity = "0";
        return;
      }
      const x = on.offsetLeft;
      const w = on.offsetWidth;
      if (!placed || reduced()) {
        gsap.set(el, { x, width: w, opacity: 1 });
        placed = true;
        return;
      }
      gsap.to(el, { x, width: w, opacity: 1, duration: 0.5, ease: "signal" });
    };
    place();
    const mo = new MutationObserver(place);
    mo.observe(box, { attributes: true, subtree: true, attributeFilter: ["aria-checked", "aria-selected"] });
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => {
      mo.disconnect();
      ro.disconnect();
    };
  }, []);
  return <span ref={ref} className="seg-thumb" aria-hidden />;
}
