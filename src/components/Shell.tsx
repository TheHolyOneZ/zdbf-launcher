import {
  BookOpen,
  Cog,
  Download,
  Gauge,
  Globe,
  Info,
  type LucideIcon,
  Play,
  Plus,
  Puzzle,
  RotateCcw,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { canStart, isBusy, STATE_LABEL, stateTone, stopwatch, type Tone } from "../lib/format";
import { emitSignal, gsap, reduced } from "../lib/motion";
import { useBotActions } from "../state/actions";
import { type Screen, useCurrent, useCurrentStatus, useStore } from "../state/store";
import { Field } from "./Field";
import { Digits, Scramble, Stage, useNow, useSpotlight } from "./fx";
import { Mark } from "./Mark";
import { Pulse } from "./Pulse";
import { TitleBar } from "./TitleBar";
import { Button, Dot, IconButton } from "./ui";

const NAV: Array<{ screen: Screen; label: string; icon: LucideIcon }> = [
  { screen: "overview", label: "Overview", icon: Gauge },
  { screen: "console", label: "Console", icon: SquareTerminal },
  { screen: "settings", label: "Settings", icon: SlidersHorizontal },
  { screen: "extensions", label: "Extensions", icon: Puzzle },
  { screen: "updates", label: "Updates", icon: Download },
  { screen: "docs", label: "Docs", icon: BookOpen },
  { screen: "dashboard", label: "Web dashboard", icon: Globe },
];

const TITLE: Record<Screen, string> = {
  overview: "Overview",
  console: "Console",
  settings: "Settings",
  extensions: "Extensions",
  updates: "Updates",
  docs: "Docs",
  dashboard: "Web dashboard",
  launcher: "Launcher",
  about: "About",
  "new-bot": "Add a bot",
};

function useCurrentTone(): Tone {
  const current = useCurrent();
  const status = useCurrentStatus();
  if (!current) return "idle";
  if (!current.setupDone) return "idle";
  return stateTone(status?.state ?? current.state, status?.diagnostics?.status ?? current.health);
}

function useSignalFeed() {
  const currentId = useStore((s) => s.currentId);
  const logs = useStore((s) => (s.currentId ? s.logs[s.currentId] : undefined));
  const seen = useRef<{ id: string | null; seq: number | null }>({ id: null, seq: null });
  useEffect(() => {
    const list = logs ?? [];
    const lastLine = list[list.length - 1];
    const prev = seen.current;
    if (prev.id !== currentId) {
      seen.current = { id: currentId, seq: lastLine?.seq ?? null };
      return;
    }
    if (!lastLine) return;
    if (prev.seq !== null && lastLine.seq > prev.seq) {
      const fresh = list.filter((l) => l.seq > (prev.seq ?? 0)).slice(-4);
      fresh.forEach((l, i) => {
        const bad = l.level === "ERROR" || l.level === "CRITICAL";
        const warn = l.level === "WARNING";
        window.setTimeout(
          () =>
            emitSignal({ tone: bad ? "bad" : warn ? "warn" : "ok", strength: bad ? 1 : warn ? 0.8 : 0.5 }),
          i * 160,
        );
      });
    }
    seen.current = { id: currentId, seq: lastLine.seq };
  }, [logs, currentId]);
}

export function Shell({ children }: { children: ReactNode }) {
  const screen = useStore((s) => s.screen);
  const currentId = useStore((s) => s.currentId);
  const tone = useCurrentTone();
  const bare = useStore((s) => s.instances.length === 0);
  const flush = bare || screen === "console" || screen === "docs";
  useSpotlight();
  useSignalFeed();
  return (
    <div className={`shell tone-${tone} screen-${screen}${bare ? " shell-bare" : ""}`}>
      <Field tone={tone} />
      {bare ? null : <Rail />}
      <div className="main">
        {bare ? null : <TopBar />}
        <main className={`content${flush ? " content-flush" : ""}`} id="content">
          <Stage key={`${screen}:${currentId ?? ""}`} className={flush ? "stage-fill" : undefined}>
            {children}
          </Stage>
        </main>
      </div>
      <Toasts />
      <TitleBar />
    </div>
  );
}

function useSlider(dep: string, container: RefObject<HTMLElement | null>) {
  const bar = useRef<HTMLLIElement>(null);
  const placed = useRef(false);
  useLayoutEffect(() => {
    const box = container.current;
    const el = bar.current;
    if (!box || !el) return;
    box.dataset.slide = dep;
    const hit = box.querySelector<HTMLElement>(".is-active");
    const active = hit?.closest<HTMLElement>("li") ?? hit;
    if (!active) {
      gsap.to(el, { opacity: 0, duration: 0.2 });
      return;
    }
    const y = active.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const h = active.getBoundingClientRect().height;
    if (!placed.current || reduced()) {
      gsap.set(el, { y, height: h, opacity: 1 });
      placed.current = true;
      return;
    }
    gsap.to(el, { y, height: h, opacity: 1, duration: 0.55, ease: "signal" });
    gsap.fromTo(el, { scaleX: 0.92 }, { scaleX: 1, duration: 0.6, ease: "elastic.out(1, 0.5)" });
  }, [dep, container]);
  return bar;
}

function Rail() {
  const screen = useStore((s) => s.screen);
  const go = useStore((s) => s.go);
  const instances = useStore((s) => s.instances);
  const currentId = useStore((s) => s.currentId);
  const select = useStore((s) => s.select);
  const statuses = useStore((s) => s.statuses);
  const release = useStore((s) => s.release);
  const launcherUpdate = useStore((s) => s.launcherUpdate);
  const app = useStore((s) => s.app);
  const current = useCurrent();
  const hasBot = current !== null && current.state !== "not_installed" && current.state !== "installing";
  const updateReady = !!release?.latest && !!current?.version && release.latest.version !== current.version;
  const navBox = useRef<HTMLUListElement>(null);
  const botBox = useRef<HTMLUListElement>(null);
  const navBar = useSlider(`${screen}:${currentId}`, navBox);
  const botBar = useSlider(`${screen}:${currentId}:${instances.length}`, botBox);

  return (
    <nav className="rail" aria-label="Main">
      <div className="brand" data-tauri-drag-region>
        <Mark size={32} />
        <div className="brand-text" data-tauri-drag-region>
          <span className="brand-name" data-tauri-drag-region>
            ZDBF
          </span>
          <span className="brand-sub" data-tauri-drag-region>
            Launcher
          </span>
        </div>
      </div>

      <div className="rail-group">
        <p className="rail-head" id="bots-head">
          Bots
        </p>
        <ul className="bots" aria-labelledby="bots-head" ref={botBox}>
          <li className="slider slider-bot" ref={botBar} aria-hidden />
          {instances.map((i) => {
            const st = statuses[i.id];
            const state = st?.state ?? i.state;
            const tone = i.setupDone ? stateTone(state, st?.diagnostics?.status ?? i.health) : "idle";
            const active =
              i.id === currentId && screen !== "new-bot" && screen !== "launcher" && screen !== "about";
            return (
              <li key={i.id}>
                <button
                  type="button"
                  className={`bot-card tone-${tone}${active ? " is-active" : ""}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => {
                    select(i.id);
                    if (screen === "launcher" || screen === "new-bot" || screen === "about") go("overview");
                  }}
                >
                  <Dot tone={tone} label={STATE_LABEL[state]} />
                  <span className="bot-card-text">
                    <span className="bot-name">{i.name}</span>
                    <span className="bot-state">
                      {i.setupDone ? STATE_LABEL[state] : "Setting up"}
                      {i.version ? <span className="bot-ver"> v{i.version}</span> : null}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          <li>
            <button
              type="button"
              className={`bot-add${screen === "new-bot" ? " is-active" : ""}`}
              onClick={() => go("new-bot")}
            >
              <span className="bot-add-icon">
                <Plus size={14} aria-hidden />
              </span>
              <span>Add a bot</span>
            </button>
          </li>
        </ul>
      </div>

      {current && screen !== "new-bot" && screen !== "launcher" && screen !== "about" ? (
        <div className="rail-group rail-pages">
          <ul className="nav" ref={navBox}>
            <li className="slider" ref={navBar} aria-hidden />
            {NAV.map(({ screen: s, label, icon: Icon }) => {
              const disabled = (!hasBot || !current.setupDone) && s !== "overview" && s !== "docs";
              return (
                <li key={s}>
                  <button
                    type="button"
                    className={`nav-item${screen === s ? " is-active" : ""}`}
                    aria-current={screen === s ? "page" : undefined}
                    disabled={disabled}
                    onClick={() => go(s)}
                  >
                    <Icon size={18} strokeWidth={1.75} aria-hidden />
                    <span>{label}</span>
                    {s === "updates" && updateReady ? (
                      <span className="nav-badge" role="img" aria-label="Update available" />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : (
        <div className="rail-spacer" data-tauri-drag-region />
      )}

      <button
        type="button"
        className={`nav-item rail-foot${screen === "about" ? " is-active" : ""}`}
        aria-current={screen === "about" ? "page" : undefined}
        onClick={() => go("about")}
      >
        <Info size={18} strokeWidth={1.75} aria-hidden />
        <span>About</span>
      </button>
      <button
        type="button"
        className={`nav-item rail-foot-last${screen === "launcher" ? " is-active" : ""}`}
        aria-current={screen === "launcher" ? "page" : undefined}
        onClick={() => go("launcher")}
      >
        <Cog size={18} strokeWidth={1.75} aria-hidden />
        <span>Launcher</span>
        {launcherUpdate ? (
          <span className="nav-badge" role="img" aria-label={`Launcher ${launcherUpdate} is available`} />
        ) : (
          <span className="rail-ver mono">{app?.version ? `v${app.version}` : ""}</span>
        )}
      </button>
    </nav>
  );
}

function TopBar() {
  const current = useCurrent();
  const status = useCurrentStatus();
  const screen = useStore((s) => s.screen);
  const actions = useBotActions(current?.id ?? null);
  const now = useNow(1000);
  const pulseRef = useRef<HTMLDivElement>(null);
  const botPage = current && screen !== "new-bot" && screen !== "launcher" && screen !== "about";

  const state = current ? (status?.state ?? current.state) : "stopped";
  const setup = !!current && (!current.setupDone || state === "not_installed" || state === "installing");
  const tone: Tone =
    !current || setup ? "idle" : stateTone(state, status?.diagnostics?.status ?? current.health);
  const busy = isBusy(state);
  const uptime = state === "running" && status?.startedAt ? (now - status.startedAt) / 1000 : null;
  const latency = status?.diagnostics?.latencyMs;

  return (
    <header className={`topbar tone-${tone}`} data-tauri-drag-region>
      <span key={screen} className="topbar-laser" aria-hidden />
      <div className="topbar-id" data-tauri-drag-region>
        <h2 className="topbar-title" data-tauri-drag-region>
          {botPage ? current.name : TITLE[screen]}
        </h2>
      </div>

      {botPage && !setup ? (
        <div className="telemetry" aria-live="polite">
          <div className="telemetry-pulse" ref={pulseRef}>
            <Pulse tone={tone} height={30} fade={[0.2, 0.8]} />
          </div>
          <div className="telemetry-read">
            <span className="telemetry-state">
              <Dot tone={tone} />
              <Scramble text={STATE_LABEL[state]} />
            </span>
            <span className="telemetry-meta mono">
              {uptime !== null ? <Digits text={stopwatch(uptime)} /> : "--:--:--"}
              {latency != null && state === "running" ? <span> {Math.round(latency)} ms</span> : null}
            </span>
          </div>
        </div>
      ) : botPage && setup ? (
        <div className="telemetry telemetry-quiet">
          <span className="chip">Setup</span>
        </div>
      ) : (
        <Fleet />
      )}

      <div className="topbar-actions">
        {!botPage || setup ? null : state === "running" || state === "starting" ? (
          <>
            <IconButton label="Restart bot" onClick={actions.restart} disabled={state === "starting"}>
              <RotateCcw size={17} />
            </IconButton>
            <Button icon={<Square size={13} fill="currentColor" />} onClick={actions.stop}>
              Stop bot
            </Button>
          </>
        ) : state === "waiting" ? (
          <Button icon={<X size={16} />} onClick={actions.stop}>
            Cancel restart
          </Button>
        ) : screen === "overview" ? null : (
          <Button
            variant="primary"
            icon={<Play size={14} fill="currentColor" />}
            onClick={actions.start}
            disabled={!canStart(state)}
            busy={busy}
          >
            Start bot
          </Button>
        )}
      </div>
    </header>
  );
}

function Fleet() {
  const instances = useStore((s) => s.instances);
  const statuses = useStore((s) => s.statuses);
  if (!instances.length) return null;
  const tones = instances.map((i) =>
    i.setupDone
      ? stateTone(statuses[i.id]?.state ?? i.state, statuses[i.id]?.diagnostics?.status ?? i.health)
      : "idle",
  );
  const live = tones.filter((t) => t === "ok" || t === "warn").length;
  return (
    <div className="telemetry fleet">
      <span className="fleet-dots">
        {instances.map((i, n) => (
          <Dot key={i.id} tone={tones[n] ?? "idle"} />
        ))}
      </span>
      <span className="telemetry-state">
        {live} of {instances.length} {instances.length === 1 ? "bot" : "bots"} online
      </span>
    </div>
  );
}

function Toasts() {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast toast-${t.tone}`}
          role={t.tone === "bad" ? "alert" : "status"}
          style={{ "--toast-ms": `${t.ms}ms` } as CSSProperties}
        >
          <span className="toast-mark" aria-hidden />
          <span className="toast-text">{t.text}</span>
          <IconButton label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={14} />
          </IconButton>
          <span className="toast-timer" aria-hidden />
        </div>
      ))}
    </div>
  );
}
