import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useState } from "react";
import { SegThumb } from "../components/fx";
import { Button, Callout, Meter, PageHead, Toggle } from "../components/ui";
import { api, errorText, type Prefs, type ThemePref } from "../lib/api";
import { applyMotion, type MotionPref, motionPref } from "../lib/motion";
import { useStore } from "../state/store";

const THEMES: Array<{ value: ThemePref; label: string }> = [
  { value: "system", label: "Like the system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function LauncherScreen() {
  const prefs = useStore((s) => s.prefs);
  const app = useStore((s) => s.app);
  const setPrefs = useStore((s) => s.setPrefs);
  const toast = useStore((s) => s.toast);
  const [motion, setMotion] = useState<MotionPref>(motionPref);

  if (!prefs || !app) return null;

  const update = async (patch: Partial<Prefs>) => {
    try {
      setPrefs(await api.setPrefs(patch));
    } catch (e) {
      toast("bad", errorText(e));
    }
  };

  return (
    <div className="narrow">
      <PageHead
        title="Launcher"
        lead="Settings for the launcher itself. Each bot has its own settings under Settings."
      />

      <section className="section">
        <h2 className="section-title">Look</h2>
        <div className="seg" role="radiogroup" aria-label="Theme">
          <SegThumb />
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="radio"
              aria-checked={prefs.theme === t.value}
              className="seg-item"
              onClick={() => update({ theme: t.value })}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="look-row">
          <p className="field-label">Animations</p>
          <div className="seg" role="radiogroup" aria-label="Animations">
            <SegThumb />
            {(
              [
                ["full", "Full"],
                ["reduced", "Reduced"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={motion === value}
                className="seg-item"
                onClick={() => {
                  applyMotion(value);
                  setMotion(value);
                  window.location.reload();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="hint">
            Reduced keeps the colours and states but stops the moving background, the heartbeat and other
            effects. It uses less power on older computers.
          </p>
        </div>
      </section>

      <section className="section stack">
        <h2 className="section-title">Running in the background</h2>
        <Toggle
          checked={prefs.closeToTray}
          onChange={(v) => update({ closeToTray: v })}
          label="Keep bots running when I close the window"
          description="The launcher stays in the system tray. Quit it from the tray icon to stop everything."
        />
        <Toggle
          checked={prefs.launchAtLogin}
          onChange={(v) => update({ launchAtLogin: v })}
          label="Open the launcher when I sign in to my computer"
          description="Bots with Start with the launcher turned on in their settings start right away."
        />
      </section>

      <section className="section stack">
        <h2 className="section-title">Launcher updates</h2>
        <Toggle
          checked={prefs.checkLauncherUpdates}
          onChange={(v) => update({ checkLauncherUpdates: v })}
          label="Check for new launcher versions"
          description="Once a day, from the launcher's GitHub releases."
        />
        <SelfUpdate version={app.version} />
      </section>

      <section className="section">
        <h2 className="section-title">About</h2>
        <dl className="kv">
          <dt>Version</dt>
          <dd className="mono">{app.version}</dd>
          <dt>System</dt>
          <dd>
            {app.os === "macos" ? "macOS" : app.os === "windows" ? "Windows" : "Linux"} ({app.arch})
          </dd>
          <dt>Launcher data</dt>
          <dd className="mono selectable">{app.dataDir}</dd>
          <dt>Licence</dt>
          <dd>
            Apache License 2.0. Fonts: SIL Open Font License 1.1. Python is provided by uv (MIT or
            Apache-2.0).
          </dd>
        </dl>
      </section>
    </div>
  );
}

function SelfUpdate({ version }: { version: string }) {
  const toast = useStore((s) => s.toast);
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "none" }
    | { kind: "found"; update: Update }
    | { kind: "downloading"; fraction: number | null }
    | { kind: "ready" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const run = async () => {
    setState({ kind: "checking" });
    try {
      const update = await check();
      setState(update ? { kind: "found", update } : { kind: "none" });
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  };

  const install = async (update: Update) => {
    let total = 0;
    let got = 0;
    setState({ kind: "downloading", fraction: null });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          got += event.data.chunkLength;
          setState({ kind: "downloading", fraction: total ? got / total : null });
        }
      });
      setState({ kind: "ready" });
    } catch (e) {
      setState({ kind: "error", message: errorText(e) });
    }
  };

  return (
    <div className="stack-tight">
      {state.kind === "found" ? (
        <Callout
          tone="info"
          title={`Launcher ${state.update.version} is available. You have ${version}.`}
          action={
            <Button variant="primary" size="sm" onClick={() => install(state.update)}>
              Update the launcher
            </Button>
          }
        >
          {state.update.body ? <p className="pre-line">{state.update.body}</p> : null}
        </Callout>
      ) : null}
      {state.kind === "downloading" ? <Meter value={state.fraction} /> : null}
      {state.kind === "ready" ? (
        <Callout
          tone="ok"
          title="The update is installed."
          action={
            <Button
              variant="primary"
              size="sm"
              onClick={async () => {
                try {
                  await relaunch();
                } catch (e) {
                  toast("bad", errorText(e));
                }
              }}
            >
              Restart the launcher
            </Button>
          }
        >
          Restarting stops running bots for a moment. Bots set to start with the launcher come back on their
          own.
        </Callout>
      ) : null}
      {state.kind === "none" ? <p className="muted">You have the newest launcher, {version}.</p> : null}
      {state.kind === "error" ? (
        <Callout tone="warn" title="Could not check for launcher updates.">
          <p className="selectable">{state.message}</p>
        </Callout>
      ) : null}
      <div className="row">
        <Button onClick={run} busy={state.kind === "checking"} disabled={state.kind === "downloading"}>
          Check now
        </Button>
      </div>
    </div>
  );
}
