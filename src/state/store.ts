import { create } from "zustand";
import type {
  AppInfo,
  BotStatus,
  InstanceSummary,
  LogLine,
  Prefs,
  Progress,
  ReleaseCheck,
  ThemePref,
} from "../lib/api";

export type Screen =
  | "overview"
  | "console"
  | "settings"
  | "extensions"
  | "updates"
  | "docs"
  | "dashboard"
  | "launcher"
  | "about"
  | "new-bot";

export interface Toast {
  id: number;
  tone: "info" | "ok" | "bad";
  text: string;
  ms: number;
}

const LOG_CAP = 4000;

interface Store {
  ready: boolean;
  app: AppInfo | null;
  prefs: Prefs | null;
  instances: InstanceSummary[];
  currentId: string | null;
  screen: Screen;
  statuses: Record<string, BotStatus>;
  logs: Record<string, LogLine[]>;
  progress: Record<string, Progress>;
  release: ReleaseCheck | null;
  toasts: Toast[];
  closePrompt: boolean;
  docTarget: string | null;
  launcherUpdate: string | null;

  setBoot: (app: AppInfo, prefs: Prefs, instances: InstanceSummary[]) => void;
  setPrefs: (prefs: Prefs) => void;
  setInstances: (list: InstanceSummary[]) => void;
  select: (id: string | null) => void;
  go: (screen: Screen) => void;
  openDoc: (path: string) => void;
  setStatus: (s: BotStatus) => void;
  setLogs: (id: string, lines: LogLine[]) => void;
  appendLogs: (id: string, lines: LogLine[]) => void;
  setProgress: (p: Progress) => void;
  clearProgress: (id: string) => void;
  setRelease: (r: ReleaseCheck) => void;
  toast: (tone: Toast["tone"], text: string) => void;
  dismissToast: (id: number) => void;
  setClosePrompt: (open: boolean) => void;
  setLauncherUpdate: (version: string | null) => void;
}

let toastSeq = 0;

export const useStore = create<Store>((set, get) => ({
  ready: false,
  app: null,
  prefs: null,
  instances: [],
  currentId: null,
  screen: "overview",
  statuses: {},
  logs: {},
  progress: {},
  release: null,
  toasts: [],
  closePrompt: false,
  docTarget: null,
  launcherUpdate: null,

  setBoot: (app, prefs, instances) => {
    const preferred = instances.find((i) => i.id === prefs.lastInstance) ?? instances[0] ?? null;
    set({
      ready: true,
      app,
      prefs,
      instances,
      currentId: preferred?.id ?? null,
      screen: preferred ? "overview" : "new-bot",
    });
  },
  setPrefs: (prefs) => set({ prefs }),
  setInstances: (list) => {
    const { currentId, screen } = get();
    const stillThere = list.some((i) => i.id === currentId);
    const next = stillThere ? currentId : (list[0]?.id ?? null);
    set({
      instances: list,
      currentId: next,
      screen: next === null && screen !== "launcher" && screen !== "about" ? "new-bot" : screen,
    });
  },
  select: (id) => set((s) => ({ currentId: id, screen: s.screen === "new-bot" ? "overview" : s.screen })),
  go: (screen) => set({ screen }),
  openDoc: (path) => set({ screen: "docs", docTarget: path }),
  setStatus: (s) => set((st) => ({ statuses: { ...st.statuses, [s.id]: s } })),
  setLogs: (id, lines) => set((st) => ({ logs: { ...st.logs, [id]: lines.slice(-LOG_CAP) } })),
  appendLogs: (id, lines) =>
    set((st) => {
      const prev = st.logs[id] ?? [];
      const last = prev.length ? (prev[prev.length - 1]?.seq ?? 0) : 0;
      const fresh = lines.filter((l) => l.seq > last);
      if (!fresh.length) return st;
      const merged = prev.concat(fresh);
      return { logs: { ...st.logs, [id]: merged.length > LOG_CAP ? merged.slice(-LOG_CAP) : merged } };
    }),
  setProgress: (p) => set((st) => ({ progress: { ...st.progress, [p.id]: p } })),
  clearProgress: (id) =>
    set((st) => {
      const next = { ...st.progress };
      delete next[id];
      return { progress: next };
    }),
  setRelease: (r) => set({ release: r }),
  toast: (tone, text) => {
    const id = ++toastSeq;
    const ms = tone === "bad" ? 9000 : 4500;
    set((st) => ({ toasts: [...st.toasts.slice(-3), { id, tone, text, ms }] }));
    window.setTimeout(() => get().dismissToast(id), ms);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  setClosePrompt: (open) => set({ closePrompt: open }),
  setLauncherUpdate: (version) => set({ launcherUpdate: version }),
}));

export function useCurrent(): InstanceSummary | null {
  return useStore((s) => s.instances.find((i) => i.id === s.currentId) ?? null);
}

export function useCurrentStatus(): BotStatus | null {
  return useStore((s) => (s.currentId ? (s.statuses[s.currentId] ?? null) : null));
}

export function resolveTheme(pref: ThemePref | undefined): "dark" | "light" {
  if (pref === "dark" || pref === "light") return pref;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}
