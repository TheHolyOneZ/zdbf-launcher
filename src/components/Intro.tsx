import { useLayoutEffect, useRef, useState } from "react";
import { gsap, reduced, SplitText } from "../lib/motion";

const HEX = "M50 4 L90 27 L90 73 L50 96 L10 73 L10 27 Z";
const Z = "M26 31 H70 L34 69 H74";
const TRACE_A = "M34 39 H56 L60 35";
const TRACE_B = "M44 61 H66 L70 57";

let played = false;

export function Intro() {
  const [done, setDone] = useState(() => played || reduced());
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = root.current;
    if (!el || done) return;
    played = true;
    let split: SplitText | null = null;
    let tl: gsap.core.Timeline | null = null;
    const brand = document.querySelector<SVGSVGElement>(".brand .mark");
    const ctx = gsap.context(() => {
      const strokes = el.querySelectorAll<SVGPathElement>("[data-stroke]");
      for (const p of strokes) {
        const len = p.getTotalLength();
        p.style.strokeDasharray = `${len}`;
        p.style.strokeDashoffset = `${len}`;
      }
      split = SplitText.create(el.querySelector(".intro-word"), { type: "chars", mask: "chars" });
      const mark = el.querySelector<SVGSVGElement>(".intro-mark");
      if (brand) gsap.set(brand, { opacity: 0 });
      tl = gsap.timeline({
        onComplete: () => {
          if (brand) gsap.set(brand, { clearProps: "opacity" });
          setDone(true);
        },
      });
      tl.to(strokes, { strokeDashoffset: 0, duration: 0.6, stagger: 0.07, ease: "power3.inOut" })
        .fromTo(
          el.querySelectorAll(".intro-node"),
          { scale: 0, transformOrigin: "50% 50%" },
          { scale: 1, duration: 0.3, stagger: 0.04, ease: "back.out(3)" },
          "-=0.3",
        )
        .from(split.chars, { yPercent: 120, duration: 0.4, stagger: 0.04, ease: "signal" }, "-=0.4")
        .addLabel("handoff", "+=0.05")
        .to(
          [el.querySelector(".intro-word"), el.querySelector(".intro-line")],
          { opacity: 0, y: 8, duration: 0.25 },
          "handoff",
        )
        .to(
          el.querySelector(".intro-bg"),
          { opacity: 0, duration: 0.55, ease: "power2.inOut" },
          "handoff+=0.1",
        );
      if (mark && brand) {
        tl.add(() => {
          const m = mark.getBoundingClientRect();
          const t = brand.getBoundingClientRect();
          gsap.to(mark, {
            x: t.left + t.width / 2 - (m.left + m.width / 2),
            y: t.top + t.height / 2 - (m.top + m.height / 2),
            scale: t.width / m.width,
            duration: 0.6,
            ease: "expo.inOut",
          });
        }, "handoff");
        tl.to({}, { duration: 0.6 }, "handoff");
      }
      tl.from(
        document.querySelectorAll(".rail > *:not(.brand), .topbar > *"),
        { y: 10, opacity: 0, duration: 0.45, stagger: 0.03, ease: "signal", clearProps: "transform,opacity" },
        "handoff+=0.25",
      );
    }, el);
    const skip = () => tl?.progress(1);
    window.addEventListener("pointerdown", skip, { once: true });
    window.addEventListener("keydown", skip, { once: true });
    return () => {
      window.removeEventListener("pointerdown", skip);
      window.removeEventListener("keydown", skip);
      ctx.revert();
      split?.revert();
      if (brand) gsap.set(brand, { clearProps: "opacity" });
    };
  }, [done]);

  if (done) return null;
  return (
    <div ref={root} className="intro" aria-hidden>
      <div className="intro-bg" />
      <div className="intro-inner">
        <svg width="120" height="120" viewBox="0 0 100 100" className="intro-mark" aria-hidden>
          <path data-stroke d={HEX} className="intro-hex" />
          <path data-stroke d={Z} className="intro-z" />
          <path data-stroke d={TRACE_A} className="intro-trace" />
          <path data-stroke d={TRACE_B} className="intro-trace" />
          {[
            [26, 31],
            [59.3, 42.8],
            [44.7, 57.2],
            [74, 69],
          ].map(([x, y]) => (
            <circle key={`${x}`} className="intro-node" cx={x} cy={y} r="4.6" />
          ))}
        </svg>
        <span className="intro-word">ZDBF</span>
        <span className="intro-line" />
      </div>
    </div>
  );
}
