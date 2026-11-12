import { useEffect } from "react";
import { ClosePrompt } from "./components/ClosePrompt";
import { Intro } from "./components/Intro";
import { Shell } from "./components/Shell";
import { Spinner } from "./components/ui";
import { api, onCloseRequested, onInstances, onLog, onProgress, onStatus } from "./lib/api";
import { AboutScreen } from "./screens/About";
import { ConsoleScreen } from "./screens/Console";
import { DashboardScreen } from "./screens/Dashboard";
import { DocsScreen } from "./screens/Docs";
import { ExtensionsScreen } from "./screens/Extensions";
import { LauncherScreen } from "./screens/Launcher";
import { NewBotScreen } from "./screens/NewBot";
import { OverviewScreen } from "./screens/Overview";
import { SettingsScreen } from "./screens/Settings";
import { UpdatesScreen } from "./screens/Updates";
import { resolveTheme, useStore } from "./state/store";

const LAUNCHER_CHECK_KEY = "zdbf.launcherUpdateCheck";

async function checkLauncher() {
  let last = 0;
  try {
    last = Number(localStorage.getItem(LAUNCHER_CHECK_KEY) ?? "0");
  } catch {
    last = 0;
  }
  if (Date.now() - last < 24 * 60 * 60 * 1000) return;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    try {
      localStorage.setItem(LAUNCHER_CHECK_KEY, String(Date.now()));
    } catch {
      return;
    }
    useStore.getState().setLauncherUpdate(update ? update.version : null);
  } catch {
    return;
  }
}

export function App() {
  const ready = useStore((s) => s.ready);
  const screen = useStore((s) => s.screen);
  const theme = useStore((s) => s.prefs?.theme);
  const currentId = useStore((s) => s.currentId);

  const os = useStore((s) => s.app?.os);
  useEffect(() => {
    if (os) document.documentElement.dataset.os = os;
  }, [os]);

  useEffect(() => {
    const apply = () => {
      document.documentElement.dataset.theme = resolveTheme(theme);
    };
    apply();
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  useEffect(() => {
    let alive = true;
    const unlisten: Array<() => void> = [];
    const keep = (u: () => void) => {
      if (alive) unlisten.push(u);
      else u();
    };
    const st = useStore.getState();
    (async () => {
      keep(await onStatus((s) => useStore.getState().setStatus(s)));
      keep(await onLog(({ id, lines }) => useStore.getState().appendLogs(id, lines)));
      keep(await onProgress((p) => useStore.getState().setProgress(p)));
      keep(await onInstances((list) => useStore.getState().setInstances(list)));
      keep(await onCloseRequested(() => useStore.getState().setClosePrompt(true)));
      if (!alive) return;
      const [app, prefs, instances] = await Promise.all([api.appInfo(), api.getPrefs(), api.listInstances()]);
      if (!alive) return;
      st.setBoot(app, prefs, instances);
      if (prefs.checkLauncherUpdates) void checkLauncher();
      for (const i of instances) {
        api
          .status(i.id)
          .then((s) => useStore.getState().setStatus(s))
          .catch(() => undefined);
      }
      api
        .releaseCheck(false)
        .then((r) => useStore.getState().setRelease(r))
        .catch(() => undefined);
    })().catch((e) => st.toast("bad", String(e)));
    const timer = window.setInterval(
      () => {
        api
          .releaseCheck(false)
          .then((r) => useStore.getState().setRelease(r))
          .catch(() => undefined);
      },
      30 * 60 * 1000,
    );
    return () => {
      alive = false;
      window.clearInterval(timer);
      for (const u of unlisten.splice(0)) u();
    };
  }, []);

  useEffect(() => {
    if (!currentId) return;
    api
      .console(currentId)
      .then((lines) => useStore.getState().setLogs(currentId, lines))
      .catch(() => undefined);
    api.setPrefs({ lastInstance: currentId }).catch(() => undefined);
  }, [currentId]);

  if (!ready) {
    return (
      <div className="boot">
        <Spinner size={22} />
      </div>
    );
  }

  return (
    <>
      <Intro />
      <Shell>
        {screen === "overview" && <OverviewScreen />}
        {screen === "console" && <ConsoleScreen />}
        {screen === "settings" && <SettingsScreen />}
        {screen === "extensions" && <ExtensionsScreen />}
        {screen === "updates" && <UpdatesScreen />}
        {screen === "docs" && <DocsScreen />}
        {screen === "dashboard" && <DashboardScreen />}
        {screen === "launcher" && <LauncherScreen />}
        {screen === "about" && <AboutScreen />}
        {screen === "new-bot" && <NewBotScreen />}
        <ClosePrompt />
      </Shell>
    </>
  );
}
