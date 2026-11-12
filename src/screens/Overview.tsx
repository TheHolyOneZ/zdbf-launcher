import { ArrowUpRight, FileCog, FolderOpen, Puzzle, ScrollText } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { CountUp, Digits, RollText, useNow } from "../components/fx";
import { Core, type CoreHandle, type RingMode } from "../components/Mark";
import { Pulse } from "../components/Pulse";
import { Button, Callout, Dot } from "../components/ui";
import { api, type BotStatus, type InstanceSummary, type LogLine, type TokenState } from "../lib/api";
import { backoffFor, clock, EXIT_TEXT, plural, STATE_LABEL, stateTone, stopwatch } from "../lib/format";
import { setSignalOrigin } from "../lib/motion";
import { useBotActions } from "../state/actions";
import { useCurrent, useCurrentStatus, useStore } from "../state/store";
import { Setup } from "./Setup";

export function OverviewScreen() {
  const current = useCurrent();
  const status = useCurrentStatus();
  if (!current) return null;
  if (!current.setupDone || current.state === "not_installed" || current.state === "installing") {
    return <Setup instance={current} status={status} />;
  }
  return <Overview instance={current} status={status} />;
}

function lineTime(l: LogLine): number | null {
  if (!l.time) return null;
  const t = Date.parse(l.time.replace(" ", "T").replace(",", "."));
  return Number.isNaN(t) ? null : t;
}

function Overview({ instance, status }: { instance: InstanceSummary; status: BotStatus | null }) {
  const now = useNow(1000);
  const go = useStore((s) => s.go);
  const logs = useStore((s) => s.logs[instance.id]);
  const actions = useBotActions(instance.id);
  const [token, setToken] = useState<TokenState | null>(null);
  const core = useRef<CoreHandle>(null);

  useEffect(() => {
    const el = core.current?.element() ?? null;
    setSignalOrigin(el);
    return () => setSignalOrigin(null);
  }, []);

  useEffect(() => {
    api
      .tokenState(instance.id)
      .then(setToken)
      .catch(() => setToken(null));
  }, [instance.id]);

  const state = status?.state ?? instance.state;
  const diag = status?.diagnostics ?? null;
  const tone = stateTone(state, diag?.status ?? instance.health);
  const running = state === "running";
  const uptime = running && status?.startedAt ? (now - status.startedAt) / 1000 : null;
  const exit = status?.lastExit ?? null;
  const restartIn = status?.restartAt
    ? Math.min(backoffFor(status.restartAttempt), Math.max(0, (status.restartAt - now) / 1000 - 0.05))
    : null;
  const botUser = status?.botUser ?? diag?.botUser ?? null;
  const guilds = status?.guilds ?? diag?.guilds ?? null;

  let headline = STATE_LABEL[state];
  let sentence: string;
  if (running) {
    sentence = botUser
      ? `Signed in to Discord as ${botUser}${guilds !== null ? `, in ${plural(guilds, "server", "servers")}` : ""}.`
      : "Signed in to Discord.";
  } else if (state === "starting") {
    sentence = "Starting Python and signing in to Discord. This usually takes a few seconds.";
  } else if (state === "stopping") {
    sentence = "Closing the connection and saving the database.";
  } else if (state === "waiting") {
    headline = "Restarting";
    sentence = `It stopped unexpectedly. Starting again in ${Math.ceil(restartIn ?? 0)} s, attempt ${status?.restartAttempt ?? 1}.`;
  } else if (state === "crashed" && exit) {
    headline = "Stopped";
    sentence = EXIT_TEXT[exit.reason].title;
  } else if (state === "updating") {
    sentence = "Updating ZDBF. The bot starts again on its own when the update is done.";
  } else {
    sentence = "The bot is offline. Start it to bring it online in your servers.";
  }

  let ringMode: RingMode = "none";
  let ring = 0;
  if (running && uptime !== null) {
    ringMode = "uptime";
    ring = (uptime % 3600) / 3600;
  } else if (state === "waiting" && restartIn !== null) {
    ringMode = "countdown";
    ring = restartIn / backoffFor(status?.restartAttempt ?? 1);
  } else if (state === "starting" || state === "stopping" || state === "updating") {
    ringMode = "spin";
  }

  const recent = (logs ?? []).filter((l) => l.level !== "DEBUG").slice(-7);
  const failed = diag?.extensionsFailed ?? [];
  const lastRunEnd = exit?.at ?? null;

  return (
    <div className="overview">
      <section className={`hero tone-${tone}`} aria-label="Bot state">
        <div className="hero-text">
          <RollText
            as="h1"
            className={`hero-state${headline.length > 8 ? " hero-state-long" : ""}`}
            text={headline}
            stretch
          />
          <p className="hero-sentence" data-reveal>
            {sentence}
          </p>
          {state === "crashed" && exit ? (
            <div className="hero-fix" data-reveal>
              {EXIT_TEXT[exit.reason].fix ? <p>{EXIT_TEXT[exit.reason].fix}</p> : null}
              {exit.message ? <pre className="hero-detail selectable">{exit.message}</pre> : null}
            </div>
          ) : null}
          <div className="hero-actions" data-reveal>
            {state === "stopped" || state === "crashed" ? (
              <Button variant="primary" size="lg" onClick={actions.start}>
                Start bot
              </Button>
            ) : null}
            {state === "waiting" ? (
              <Button variant="primary" size="lg" onClick={actions.start}>
                Start now
              </Button>
            ) : null}
            {state === "crashed" &&
            exit &&
            (exit.reason === "token_invalid" || exit.reason === "token_missing") ? (
              <Button size="lg" onClick={() => go("settings")}>
                Replace the token
              </Button>
            ) : null}
            {state === "crashed" && exit?.reason === "config" ? (
              <Button size="lg" onClick={() => go("settings")}>
                Open settings
              </Button>
            ) : null}
            {running && guilds === 0 && token?.inviteUrl ? (
              <Button
                variant="primary"
                size="lg"
                onClick={() => token.inviteUrl && api.openUrl(token.inviteUrl)}
              >
                Invite the bot to a server
              </Button>
            ) : null}
          </div>
        </div>
        <div className="hero-core">
          <Core tone={tone} ring={ring} ringMode={ringMode} handle={core} listen />
          {ringMode === "countdown" && restartIn !== null ? (
            <span className="hero-count mono">{Math.ceil(restartIn)}</span>
          ) : null}
        </div>
        <div className="hero-pulse" aria-hidden>
          <Pulse tone={tone} height={72} fade={[0.08, 0.9]} />
        </div>
      </section>

      {running ? (
        <section className="instruments" aria-label="Health">
          <Instrument label="Health" data-tone={diag?.status ?? "none"}>
            {diag ? (
              <>
                <span className="inst-value">
                  <Dot
                    tone={diag.status === "healthy" ? "ok" : diag.status === "degraded" ? "warn" : "bad"}
                  />
                  {diag.status === "healthy"
                    ? "Healthy"
                    : diag.status === "degraded"
                      ? "Degraded"
                      : "Critical"}
                </span>
                <span className="inst-foot">
                  {diag.stale
                    ? `Last check ${clock(Date.parse(diag.generatedAt))}`
                    : `${plural(diag.extensionsLoaded, "extension", "extensions")} loaded`}
                </span>
              </>
            ) : (
              <>
                <span className="inst-value inst-wait">Checking</span>
                <span className="inst-foot">The first check runs 5 minutes after start</span>
              </>
            )}
          </Instrument>
          <Instrument label="Running for">
            <span className="inst-value mono">
              {uptime !== null ? <Digits text={stopwatch(uptime)} /> : "00:00:00"}
            </span>
            <span className="inst-foot">Since {status?.startedAt ? clock(status.startedAt) : "now"}</span>
          </Instrument>
          <Instrument label="Latency">
            {diag?.latencyMs != null ? (
              <>
                <span className="inst-value">
                  <CountUp value={diag.latencyMs} />
                  <span className="inst-unit">ms</span>
                </span>
                <Gauge value={diag.latencyMs} />
                <span className="gauge-scale">
                  <span>0</span>
                  <span>200</span>
                  <span>400 ms</span>
                </span>
              </>
            ) : (
              <>
                <span className="inst-value inst-wait">Measuring</span>
                <span className="inst-foot">Shown after the first health check</span>
              </>
            )}
          </Instrument>
          <Instrument label="Servers">
            <span className="inst-value">{guilds !== null ? <CountUp value={guilds} /> : "–"}</span>
            <span className="inst-foot">{guilds === 1 ? "Discord server" : "Discord servers"}</span>
          </Instrument>
        </section>
      ) : state === "crashed" && exit ? (
        <CrashCard exitCode={exit.code} at={exit.at} logs={logs ?? []} onConsole={() => go("console")} />
      ) : state === "stopped" && lastRunEnd ? (
        <p className="offline-line" data-reveal>
          Offline since {clock(lastRunEnd)}.
          {exit && exit.code !== null && exit.code !== 0 ? (
            <span className="faint"> Last exit code {exit.code}.</span>
          ) : null}
        </p>
      ) : null}

      {failed.length > 0 && running ? (
        <Callout
          tone="warn"
          title={`${plural(failed.length, "extension", "extensions")} failed to load`}
          action={
            <Button size="sm" onClick={() => go("console")}>
              Show in console
            </Button>
          }
        >
          {failed.join(", ")}
        </Callout>
      ) : null}

      <div className="overview-split">
        <section className="terminal panel spot" aria-labelledby="recent-head" data-reveal>
          <header className="terminal-head">
            <h2 id="recent-head" className="terminal-title">
              Latest output
            </h2>
            {running ? (
              <span className="live-pill">
                <span className="live-dot" />
                Live
              </span>
            ) : null}
            <Button variant="quiet" size="sm" icon={<ArrowUpRight size={15} />} onClick={() => go("console")}>
              Console
            </Button>
          </header>
          {recent.length ? (
            <ol className="terminal-lines mono selectable">
              {recent.map((l) => (
                <RecentLine key={l.seq} line={l} />
              ))}
            </ol>
          ) : (
            <p className="terminal-empty faint">Nothing yet. Output shows up here when the bot runs.</p>
          )}
        </section>
        <Activity logs={logs ?? []} now={now} />
      </div>

      <section className="shortcuts" aria-label="Files and folders" data-reveal>
        <Shortcut
          icon={<FolderOpen size={18} />}
          label="Bot folder"
          onClick={() => api.open(instance.id, "folder")}
        />
        <Shortcut
          icon={<FileCog size={18} />}
          label="config.toml"
          onClick={() => api.open(instance.id, "config")}
        />
        <Shortcut
          icon={<ScrollText size={18} />}
          label="Log files"
          onClick={() => api.open(instance.id, "logs")}
        />
        <Shortcut
          icon={<Puzzle size={18} />}
          label="Extensions folder"
          onClick={() => api.open(instance.id, "extensions")}
        />
      </section>
    </div>
  );
}

function CrashCard({
  exitCode,
  at,
  logs,
  onConsole,
}: {
  exitCode: number | null;
  at: number;
  logs: LogLine[];
  onConsole: () => void;
}) {
  const lastError = [...logs].reverse().find((l) => l.level === "ERROR" || l.level === "CRITICAL");
  return (
    <section className="crash panel" data-reveal>
      <dl className="crash-facts">
        <div>
          <dt>Stopped at</dt>
          <dd>{clock(at)}</dd>
        </div>
        <div>
          <dt>Exit code</dt>
          <dd className="mono">{exitCode ?? "none"}</dd>
        </div>
      </dl>
      {lastError ? (
        <p className="crash-line mono selectable">
          {lastError.message}
          {lastError.trace.length ? ` (${plural(lastError.trace.length, "line", "lines")} of details)` : ""}
        </p>
      ) : (
        <p className="crash-line faint">No error was logged before it stopped.</p>
      )}
      <Button size="sm" onClick={onConsole}>
        Show in the console
      </Button>
    </section>
  );
}

function Instrument({
  label,
  children,
  ...rest
}: {
  label: string;
  children: ReactNode;
  "data-tone"?: string;
}) {
  return (
    <div className="instrument panel spot" data-reveal {...rest}>
      <span className="inst-label">{label}</span>
      {children}
    </div>
  );
}

function Gauge({ value }: { value: number }) {
  const v = Math.min(1, value / 400);
  const tone = value < 150 ? "ok" : value < 300 ? "warn" : "bad";
  return (
    <span className="gauge" aria-hidden>
      <span className={`gauge-fill gauge-${tone}`} style={{ transform: `scaleX(${Math.max(0.03, v)})` }} />
      <span className="gauge-ticks" />
    </span>
  );
}

const BUCKETS = 30;
const SLICE = 20000;

function Activity({ logs, now }: { logs: LogLine[]; now: number }) {
  const minute = Math.floor(now / SLICE);
  const bars = useMemo(() => {
    const out = Array.from({ length: BUCKETS }, () => ({ n: 0, warn: 0, bad: 0 }));
    for (const l of logs) {
      const t = lineTime(l);
      if (t === null) continue;
      const idx = BUCKETS - 1 - (minute - Math.floor(t / SLICE));
      const b = out[idx];
      if (!b) continue;
      b.n += 1;
      if (l.level === "WARNING") b.warn += 1;
      if (l.level === "ERROR" || l.level === "CRITICAL") b.bad += 1;
    }
    return out;
  }, [logs, minute]);
  const max = Math.max(4, ...bars.map((b) => b.n));
  const total = bars.reduce((a, b) => a + b.n, 0);
  const problems = bars.reduce((a, b) => a + b.warn + b.bad, 0);
  return (
    <section className="activity panel spot" aria-label="Log activity" data-reveal>
      <header className="activity-head">
        <span className="inst-label">Activity, last 10 minutes</span>
        <span className="activity-sum">
          <CountUp value={total} /> lines
          {problems ? (
            <span className="activity-bad">
              {" "}
              {plural(problems, "warning or error", "warnings or errors")}
            </span>
          ) : null}
        </span>
      </header>
      <div className="activity-bars">
        {bars.map((b, i) => (
          <span
            key={`b${minute - (BUCKETS - 1 - i)}`}
            className={`bar${b.bad ? " bar-bad" : b.warn ? " bar-warn" : ""}${b.n === 0 ? " bar-zero" : ""}`}
            style={{ transform: `scaleY(${Math.max(0.04, b.n / max)})`, transitionDelay: `${i * 12}ms` }}
          />
        ))}
      </div>
      <div className="activity-axis faint">
        <span>10 min ago</span>
        <span>now</span>
      </div>
    </section>
  );
}

function Shortcut({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button type="button" className="shortcut panel spot" onClick={onClick}>
      <span className="shortcut-icon">{icon}</span>
      <span className="shortcut-label">{label}</span>
      <ArrowUpRight className="shortcut-arrow" size={16} aria-hidden />
    </button>
  );
}

function RecentLine({ line }: { line: LogLine }) {
  return (
    <li className={`lv-${line.level.toLowerCase()}`}>
      <span className="rl-time">{line.time.slice(11, 19) || line.time}</span>
      <span className="rl-msg">{line.message}</span>
    </li>
  );
}
