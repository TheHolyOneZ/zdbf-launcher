import { History, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Markdown } from "../components/Markdown";
import { Pipeline } from "../components/Pipeline";
import { Button, Callout, Meter, PageHead, Spinner } from "../components/ui";
import { api, type BackupInfo, errorText, type UpdatePlan } from "../lib/api";
import { bytes, clock, dateTime } from "../lib/format";
import { useCurrent, useCurrentStatus, useStore } from "../state/store";

const PIPE = [
  { id: "stop", label: "Stop", note: "the bot" },
  { id: "backup", label: "Back up", note: "files and data" },
  { id: "files", label: "Replace", note: "ZDBF's own files" },
  { id: "packages", label: "Packages", note: "update Python" },
  { id: "check", label: "Check", note: "your settings" },
  { id: "start", label: "Start", note: "the bot again" },
];

function pipeIndex(step: string | null): number {
  if (step === null) return -1;
  if (step === "release" || step === "extract") return -1;
  if (step.startsWith("rollback")) return PIPE.length;
  const i = PIPE.findIndex((p) => p.id === step);
  return i >= 0 ? i : 3;
}

function UpdatePipeline({ step, running }: { step: string | null; running: boolean }) {
  const steps = PIPE.map((p) =>
    !running && (p.id === "stop" || p.id === "start") ? { ...p, note: "skipped, not running" } : p,
  );
  return (
    <Pipeline
      steps={steps}
      at={step === null ? null : pipeIndex(step)}
      back={step?.startsWith("rollback") ?? false}
    />
  );
}

function Lockup({ from, to, live }: { from: string | null; to: string | null; live?: boolean }) {
  return (
    <p className={`lockup${live ? " is-live" : ""}`}>
      <span className="visually-hidden">{`From ${from ?? "unknown"} to ${to ?? "unknown"}`}</span>
      <span className="lockup-from" aria-hidden>
        {from ?? "?"}
      </span>
      <span className="lockup-wire" aria-hidden>
        <span className="lockup-packet" />
      </span>
      <span className="lockup-to" aria-hidden>
        {to ?? "?"}
      </span>
    </p>
  );
}

export function UpdatesScreen() {
  const current = useCurrent();
  const status = useCurrentStatus();
  const release = useStore((s) => s.release);
  const setRelease = useStore((s) => s.setRelease);
  const progress = useStore((s) => (current ? s.progress[current.id] : undefined));
  const clearProgress = useStore((s) => s.clearProgress);
  const toast = useStore((s) => s.toast);
  const [plan, setPlan] = useState<UpdatePlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [confirmRestore, setConfirmRestore] = useState<BackupInfo | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      setPlan(await api.updatePlan(current.id));
      setPlanError(null);
    } catch (e) {
      setPlanError(errorText(e));
    }
    api
      .listBackups(current.id)
      .then(setBackups)
      .catch(() => setBackups([]));
  }, [current]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!current) return null;
  const updating = progress?.task === "update" && !progress.done;
  const running = (status?.state ?? current.state) === "running";

  const checkNow = async () => {
    setChecking(true);
    setResult(null);
    try {
      setRelease(await api.releaseCheck(true));
      await load();
    } catch (e) {
      toast("bad", errorText(e));
    } finally {
      setChecking(false);
    }
  };

  const update = async () => {
    setResult(null);
    clearProgress(current.id);
    try {
      const msg = await api.updateBot(current.id);
      setResult({ ok: true, text: msg });
    } catch (e) {
      setResult({ ok: false, text: errorText(e) });
    } finally {
      clearProgress(current.id);
      await load();
    }
  };

  const latest = plan?.latest ?? release?.latest ?? null;

  return (
    <div className="narrow-wide updates">
      <PageHead
        title="Updates"
        lead="New versions of ZDBF come from its GitHub releases. Your settings, token, data and extensions are kept."
        actions={
          <Button icon={<RefreshCw size={16} />} onClick={checkNow} busy={checking} disabled={updating}>
            Check now
          </Button>
        }
      />

      {release?.rateLimitedUntil ? (
        <Callout
          tone="warn"
          title={`GitHub's limit for update checks is reached until ${clock(release.rateLimitedUntil)}.`}
        >
          GitHub allows 60 checks per hour from one internet connection. The launcher tries again after that.
        </Callout>
      ) : release?.offline ? (
        <Callout tone="warn" title="No connection to GitHub.">
          Check your internet connection. The launcher keeps trying in the background.
        </Callout>
      ) : release?.error ? (
        <Callout tone="warn" title="The update check did not work.">
          <p className="selectable">{release.error}</p>
        </Callout>
      ) : null}

      {result ? (
        <Callout
          tone={result.ok ? "ok" : "bad"}
          title={result.ok ? "Update finished." : "The update did not work."}
        >
          <p className="selectable">{result.text}</p>
        </Callout>
      ) : null}

      {planError ? (
        <Callout tone="bad" title="The update check did not work.">
          <p className="selectable">{planError}</p>
        </Callout>
      ) : !plan ? (
        <p className="progress-label">
          <Spinner /> Checking for updates
        </p>
      ) : updating && progress ? (
        <section className={`update-card${progress.step.startsWith("rollback") ? " is-rollback" : ""}`}>
          <Lockup from={plan.current} to={latest?.version ?? null} live />
          <UpdatePipeline step={progress.step} running={running} />
          <p className="progress-label">
            <Spinner /> {progress.label}
          </p>
          <Meter value={progress.fraction} />
          {progress.detail ? <p className="faint mono progress-detail">{progress.detail}</p> : null}
          <p className="hint">Do not close the launcher until this is done.</p>
        </section>
      ) : plan.available && latest ? (
        <section className="update-card is-available">
          <div className="update-head">
            <div>
              <h2 className="update-title">A new version is ready</h2>
              <Lockup from={plan.current} to={latest.version} />
              <p className="muted">
                Released {latest.publishedAt ? dateTime(Date.parse(latest.publishedAt)) : "recently"}.
              </p>
            </div>
            <Button variant="primary" size="lg" onClick={update}>
              Update to {latest.version}
            </Button>
          </div>
          <UpdatePipeline step={null} running={running} />
          <p className="hint">
            Only ZDBF's own files are replaced. Your settings, token, data and extensions stay as they are. If
            any step fails, the launcher puts the previous version back on its own.
          </p>
          {plan.changedByYou.length > 0 ? (
            <Callout tone="warn" title={`You changed ${plan.changedByYou.length} of ZDBF's own files.`}>
              <p>
                The update replaces them with the new version. Your copies are saved in the backup, so you can
                take your changes from there.
              </p>
              <p className="mono selectable">{plan.changedByYou.slice(0, 8).join(", ")}</p>
            </Callout>
          ) : null}
          {latest.notes ? (
            <div className="changelog">
              <h3 className="changelog-title">What changed</h3>
              <Markdown text={latest.notes} />
            </div>
          ) : null}
        </section>
      ) : (
        <section className="update-card">
          <h2 className="update-title">ZDBF {plan.current} is the newest version.</h2>
          <p className="muted">
            {release?.checkedAt
              ? `Last checked at ${clock(release.checkedAt)}. The launcher checks again every 12 hours.`
              : "The launcher checks every 12 hours."}
          </p>
        </section>
      )}

      <section className="section backups">
        <h2 className="section-title">Backups</h2>
        <p className="section-lead">
          Taken before every update and every restore. The newest three are kept in the bot folder under
          .zdbf-launcher/backups.
        </p>
        {backups.length === 0 ? (
          <p className="faint">No backups yet.</p>
        ) : (
          <ul className="backup-list">
            {backups.map((b) => (
              <li key={b.name}>
                <History size={17} aria-hidden className="faint" />
                <span className="backup-name">ZDBF {b.version ?? "unknown"}</span>
                <span className="faint">{dateTime(b.createdAt)}</span>
                <span className="faint">{bytes(b.sizeBytes)}</span>
                <Button
                  size="sm"
                  variant="quiet"
                  disabled={running || updating}
                  onClick={() => setConfirmRestore(b)}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
        )}
        {running && backups.length > 0 ? <p className="hint">Stop the bot to restore a backup.</p> : null}
      </section>

      <Dialog
        open={confirmRestore !== null}
        title={`Restore ZDBF ${confirmRestore?.version ?? ""}?`}
        onClose={() => setConfirmRestore(null)}
        actions={
          <>
            <Button onClick={() => setConfirmRestore(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={async () => {
                const b = confirmRestore;
                setConfirmRestore(null);
                if (!b) return;
                try {
                  await api.restoreBackup(current.id, b.name);
                  setResult({
                    ok: true,
                    text: `ZDBF ${b.version ?? ""} from ${dateTime(b.createdAt)} is restored.`,
                  });
                } catch (e) {
                  setResult({ ok: false, text: errorText(e) });
                } finally {
                  clearProgress(current.id);
                  await load();
                }
              }}
            >
              Restore
            </Button>
          </>
        }
      >
        <p>
          ZDBF, config.toml, .env, the data folder and the extensions folder go back to how they were on{" "}
          {confirmRestore ? dateTime(confirmRestore.createdAt) : ""}. Changes made since then, including the
          database, are replaced.
        </p>
        <p>The launcher takes a backup of the current state first, so you can go back.</p>
      </Dialog>
    </div>
  );
}
