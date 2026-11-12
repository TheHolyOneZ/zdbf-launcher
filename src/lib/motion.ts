import { gsap } from "gsap";
import { CustomEase } from "gsap/CustomEase";
import { Flip } from "gsap/Flip";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { SplitText } from "gsap/SplitText";
import type { Tone } from "./format";

gsap.registerPlugin(CustomEase, Flip, ScrambleTextPlugin, SplitText);

CustomEase.create("signal", "M0,0 C0.12,0.72 0.18,1 1,1");
CustomEase.create("snap", "M0,0 C0.5,0 0.08,1 1,1");
CustomEase.create("drift", "M0,0 C0.3,0 0.1,1 1,1");

gsap.defaults({ ease: "signal", duration: 0.7 });

const query = window.matchMedia("(prefers-reduced-motion: reduce)");

const MOTION_KEY = "zdbf.motion";

export type MotionPref = "full" | "reduced";

export function motionPref(): MotionPref {
  try {
    return localStorage.getItem(MOTION_KEY) === "reduced" ? "reduced" : "full";
  } catch {
    return "full";
  }
}

export function applyMotion(pref: MotionPref) {
  document.documentElement.dataset.motion = pref;
  try {
    localStorage.setItem(MOTION_KEY, pref);
  } catch {
    return;
  }
}

document.documentElement.dataset.motion = motionPref();

export function reduced() {
  return query.matches || document.documentElement.dataset.motion === "reduced";
}

export const TONE_COLOR: Record<Tone, string> = {
  ok: "--signal",
  warn: "--warn",
  bad: "--bad",
  idle: "--idle",
  busy: "--warn",
};

export function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

export interface Signal {
  tone: Tone;
  strength: number;
}

type SignalListener = (s: Signal) => void;
const signalListeners = new Set<SignalListener>();
let origin: Element | null = null;

export function onSignal(fn: SignalListener) {
  signalListeners.add(fn);
  return () => {
    signalListeners.delete(fn);
  };
}

let lastRipple = 0;

export function emitSignal(s: Signal) {
  for (const fn of signalListeners) fn(s);
  const now = performance.now();
  if (!origin?.isConnected || now - lastRipple < (s.strength >= 0.8 ? 400 : 1400)) return;
  lastRipple = now;
  emitBeatFrom(origin, s.tone, s.strength);
}

export function setSignalOrigin(el: Element | null, weak = false) {
  if (weak && origin?.isConnected) return;
  origin = el;
}

export interface Beat {
  x: number;
  y: number;
  tone: Tone;
  strength: number;
}

type BeatListener = (b: Beat) => void;
const beatListeners = new Set<BeatListener>();

export function onBeat(fn: BeatListener) {
  beatListeners.add(fn);
  return () => {
    beatListeners.delete(fn);
  };
}

export function emitBeat(b: Beat) {
  for (const fn of beatListeners) fn(b);
}

export function emitBeatFrom(el: Element | null, tone: Tone, strength = 1) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  emitBeat({ x: r.left + r.width / 2, y: r.top + r.height / 2, tone, strength });
}

export { CustomEase, Flip, gsap, ScrambleTextPlugin, SplitText };
