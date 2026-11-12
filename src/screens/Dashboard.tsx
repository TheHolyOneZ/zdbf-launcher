import { Check, ExternalLink, Play, RotateCcw, Square } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Pipeline } from "../components/Pipeline";
import { Button, Callout, CopyLine, Dot, Meter, PageHead, Spinner } from "../components/ui";
import { api, type DashboardState, errorText } from "../lib/api";
import { useCurrent, useCurrentStatus, useStore } from "../state/store";

const DASH = [
  { id: "module", label: "Module", note: "the bot's dashboard module turns on" },
  { id: "php", label: "PHP", note: "downloaded once" },
  { id: "web", label: "Files", note: "the dashboard is prepared" },
  { id: "server", label: "Server", note: "only this computer can reach it" },
  { id: "open", label: "Setup", note: "create the owner account in your browser" },
];

export function DashboardScreen() {
  const current = useCurrent();
  const status = useCurrentStatus();
  const progress = useStore((s) => (current ? s.progress[current.id] : undefined));
  const clearProgress = useStore((s) => s.clearProgress);
  const toast = useStore((s) => s.toast);
  const [st, setSt] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      setSt(await api.dashboardState(current.id));
    } catch (e) {
      setError(errorText(e));
    }
  }, [current]);

  useEffect(() => {
    void load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [load]);

  if (!current) return null;
  const botState = status?.state ?? current.state;
  const botRunning = botState === "running";
  const working = progress?.task === "dashboard" && !progress.done;

  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    try {
      const r = await fn();
      if (r && typeof r === "object" && "running" in r) setSt(r as DashboardState);
      else await load();
    } catch (e) {
      toast("bad", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const setup = async () => {
    setError(null);
    clearProgress(current.id);
    setBusy("setup");
    try {
      const r = await api.dashboardSetup(current.id);
      setSt(r);
      await api.dashboardOpen(current.id, "setup").catch(() => undefined);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
      clearProgress(current.id);
    }
  };

  const serverLine = st ? (
    <div className="dash-server">
      <Dot tone={st.running ? "ok" : "idle"} />
      <span>
        {st.running && st.url ? (
          <>
            Local web server running at <span className="mono selectable">{st.url}</span>
          </>
        ) : (
          "Local web server stopped. It starts with the bot."
        )}
      </span>
      {st.running ? (
        <Button
          size="sm"
          variant="quiet"
          icon={<Square size={13} fill="currentColor" />}
          onClick={() => run("stop", () => api.dashboardStop(current.id))}
          busy={busy === "stop"}
        >
          Stop server
        </Button>
      ) : (
        <Button
          size="sm"
          variant="quiet"
          icon={<Play size={13} fill="currentColor" />}
          onClick={() => run("start", () => api.dashboardStart(current.id))}
          busy={busy === "start"}
        >
          Start server
        </Button>
      )}
    </div>
  ) : null;

  return (
    <div className="narrow-wide dash">
      <PageHead
        title="Web dashboard"
        lead="Control the bot from your browser: chat as the bot, run commands, edit extension files, manage backups and watch the log. This sets it up on this computer, for this bot."
      />

      {error ? (
        <Callout tone="bad" title="The dashboard could not be set up.">
          <p className="selectable">{error}</p>
        </Callout>
      ) : null}

      {!st ? (
        <p className="progress-label">
          <Spinner /> Checking the dashboard
        </p>
      ) : !st.supported ? (
        <Callout tone="warn" title="The local dashboard is not available for this system yet.">
          You can still put the dashboard on ordinary web hosting with /dashboard export in Discord. The guide
          is under Docs, Web dashboard.
        </Callout>
      ) : working && progress ? (
        <section className="update-card">
          <h2 className="update-title">Setting up the dashboard</h2>
          <Pipeline
            steps={DASH}
            at={Math.max(
              0,
              DASH.findIndex((d) => d.id === progress.step),
            )}
          />
          <p className="progress-label">
            <Spinner /> {progress.label}
          </p>
          <Meter value={progress.fraction} />
          {progress.detail ? <p className="faint mono progress-detail">{progress.detail}</p> : null}
        </section>
      ) : !st.prepared ? (
        <section className="update-card">
          <h2 className="update-title">Set up the dashboard on this computer</h2>
          <Pipeline
            steps={DASH.map((d) =>
              d.id === "php" ? { ...d, note: `PHP ${st.phpVersion ?? ""}, kept inside the launcher` } : d,
            )}
            at={null}
          />
          <div className="row">
            <Button variant="primary" size="lg" onClick={setup} busy={busy === "setup"}>
              Set up the dashboard
            </Button>
          </div>
          <p className="hint">
            The dashboard works while this launcher runs the bot on this computer. For access from other
            devices, put it on web hosting instead; the guide is under Docs, Web dashboard.
          </p>
        </section>
      ) : st.setupDone && st.paired ? (
        <section className="update-card is-ready">
          <div className="update-head">
            <div>
              <h2 className="update-title">The dashboard is ready</h2>
              <p className="muted">Log in with the owner account you created in setup.</p>
            </div>
            <Button
              variant="primary"
              size="lg"
              icon={<ExternalLink size={17} />}
              disabled={!st.running}
              onClick={() => api.dashboardOpen(current.id, "home").catch((e) => toast("bad", errorText(e)))}
            >
              Open the dashboard
            </Button>
          </div>
          {serverLine}
          {!botRunning ? (
            <Callout
              tone="info"
              title="The bot is not running."
              action={
                <Button
                  size="sm"
                  variant="primary"
                  onClick={() => api.start(current.id).catch((e) => toast("bad", errorText(e)))}
                >
                  Start bot
                </Button>
              }
            >
              The dashboard shows the bot as offline until it runs. The web server starts with it.
            </Callout>
          ) : null}
        </section>
      ) : (
        <section className="update-card">
          <h2 className="update-title">Finish the setup</h2>
          {serverLine}
          <ol className="dash-steps">
            <DashStep n={1} done={st.setupDone} title="Create the owner account">
              <p className="muted">
                The setup page asks for the setup key, a database (keep SQLite) and the owner account.
              </p>
              {st.setupKey ? <CopyLine text={st.setupKey} label="Copy the setup key" /> : null}
              <div className="row">
                <Button
                  variant="primary"
                  icon={<ExternalLink size={16} />}
                  disabled={!st.running}
                  onClick={() =>
                    api.dashboardOpen(current.id, "setup").catch((e) => toast("bad", errorText(e)))
                  }
                >
                  Open the setup page
                </Button>
              </div>
            </DashStep>
            <DashStep n={2} done={st.paired} title="Connect the bot">
              <p className="muted">
                The last setup page shows a command that starts with{" "}
                <code>/dashboard pair url:{st.url ?? "http://127.0.0.1:…"}</code>. Copy it from there and run
                it in Discord as the bot owner within 10 minutes. The bot needs to be running.
              </p>
              {botRunning ? (
                <p className="hint">
                  No /dashboard command in Discord? The module was just turned on; restart the bot once.{" "}
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => api.restart(current.id).catch((e) => toast("bad", errorText(e)))}
                  >
                    <RotateCcw size={12} aria-hidden /> Restart bot
                  </button>
                </p>
              ) : (
                <div className="row">
                  <Button onClick={() => api.start(current.id).catch((e) => toast("bad", errorText(e)))}>
                    Start bot
                  </Button>
                </div>
              )}
              <p className="hint">This page notices on its own when the bot is connected.</p>
            </DashStep>
          </ol>
        </section>
      )}

      {st?.prepared ? (
        <section className="section">
          <h2 className="section-title">Turn the dashboard off</h2>
          <p className="section-lead">
            Stops the web server and turns the dashboard module off. The account and the dashboard database
            stay, so you can turn it on again later.
          </p>
          <Button
            variant="danger"
            disabled={!st.enabled}
            busy={busy === "disable"}
            onClick={() => run("disable", () => api.dashboardDisable(current.id))}
          >
            Turn the dashboard off
          </Button>
          {!st.enabled ? (
            <div className="row dash-reenable">
              <span className="muted">The dashboard module is off.</span>
              <Button size="sm" onClick={setup} busy={busy === "setup"}>
                Turn it on again
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function DashStep({
  n,
  done,
  title,
  children,
}: {
  n: number;
  done: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className={`step ${done ? "step-done" : "step-current"}`}>
      <span className="step-n" aria-hidden>
        {done ? <Check size={15} strokeWidth={2.5} /> : n}
      </span>
      <div className="step-body">
        <div className="step-title-row">
          <h3 className="step-title">{title}</h3>
          {done ? <span className="faint">Done</span> : null}
        </div>
        {done ? null : <div className="step-content stack-tight">{children}</div>}
      </div>
    </li>
  );
}
