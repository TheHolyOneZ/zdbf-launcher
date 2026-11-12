import { Check, ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { CountUp, RollText } from "../components/fx";
import { Core } from "../components/Mark";
import { Button, Callout, Field, Meter, SecretInput, Spinner } from "../components/ui";
import { api, type BotStatus, errorText, type InstanceSummary, type TokenState } from "../lib/api";
import { EXIT_TEXT, plural } from "../lib/format";
import { useStore } from "../state/store";

const PORTAL = "https://discord.com/developers/applications";

type StepState = "done" | "current" | "later";

export function Setup({ instance, status }: { instance: InstanceSummary; status: BotStatus | null }) {
  const progress = useStore((s) => s.progress[instance.id]);
  const release = useStore((s) => s.release);
  const toast = useStore((s) => s.toast);
  const [token, setToken] = useState<TokenState | null>(null);
  const [intentsOk, setIntentsOk] = useState(false);

  const installed = instance.state !== "not_installed" && instance.state !== "installing";
  const installing = instance.state === "installing" || (progress?.task === "install" && !progress.done);

  useEffect(() => {
    if (!installed) return;
    api
      .tokenState(instance.id)
      .then(setToken)
      .catch(() => setToken(null));
  }, [instance.id, installed]);

  const tokenSet = !!token?.set;
  const steps: StepState[] = [
    installed ? "done" : "current",
    !installed ? "later" : tokenSet ? "done" : "current",
    !installed || !tokenSet ? "later" : intentsOk ? "done" : "current",
    !installed || !tokenSet || !intentsOk ? "later" : "current",
  ];

  const running = (status?.state ?? instance.state) === "running";
  const starting = (status?.state ?? instance.state) === "starting";
  const stage = running ? 4 : steps.filter((x) => x === "done").length;
  const done = steps.filter((x) => x === "done").length;

  return (
    <div className="setup">
      <div className="setup-main">
        <header className="setup-head">
          <RollText as="h1" className="setup-title" text={`Set up ${instance.name}`} />
          <p className="page-lead" data-reveal>
            Four steps, about five minutes. You need a Discord account and a server where you may add bots.
          </p>
        </header>

        <ol className="steps">
          <Step
            n={1}
            state={steps[0] ?? "later"}
            title="Install ZDBF"
            summary={installed ? `ZDBF ${instance.version ?? ""} is installed.` : null}
          >
            <InstallStep
              instance={instance}
              installing={installing}
              progress={progress ?? null}
              version={release?.latest?.version ?? null}
              onError={(m) => toast("bad", m)}
            />
          </Step>
          <Step
            n={2}
            state={steps[1] ?? "later"}
            title="Add your bot token"
            summary={tokenSet ? `Token saved for the bot with ID ${token?.botId ?? "unknown"}.` : null}
            onEdit={tokenSet ? () => setToken({ set: false, botId: null, inviteUrl: null }) : undefined}
          >
            <TokenStep instanceId={instance.id} onSaved={setToken} />
          </Step>
          <Step
            n={3}
            state={steps[2] ?? "later"}
            title="Turn on two settings in Discord and invite the bot"
            summary={intentsOk ? "Intents are on and the bot is invited." : null}
            onEdit={intentsOk ? () => setIntentsOk(false) : undefined}
          >
            <IntentsStep token={token} onDone={() => setIntentsOk(true)} />
          </Step>
          <Step n={4} state={steps[3] ?? "later"} title="Start the bot">
            <StartStep
              instance={instance}
              status={status}
              onBackToToken={() => setToken({ set: false, botId: null, inviteUrl: null })}
              onBackToIntents={() => setIntentsOk(false)}
            />
          </Step>
        </ol>
      </div>
      <aside className="setup-side" aria-hidden>
        <div className="setup-core">
          <Core
            tone={installing || starting ? "busy" : running ? "ok" : "idle"}
            stage={stage}
            size={260}
            ringMode={installing || starting ? "spin" : "uptime"}
            ring={stage / 4}
          />
          <div className="setup-progress">
            <span className="setup-count">
              <CountUp value={running ? 4 : done} />
              <span className="faint">/4</span>
            </span>
            <span className="faint">{running ? "Online" : installing ? "Installing" : "steps done"}</span>
          </div>
        </div>
      </aside>
    </div>
  );
}

function Step({
  n,
  state,
  title,
  summary,
  children,
  onEdit,
}: {
  n: number;
  state: StepState;
  title: string;
  summary?: string | null;
  children: ReactNode;
  onEdit?: () => void;
}) {
  return (
    <li className={`step step-${state}`} aria-current={state === "current" ? "step" : undefined}>
      <span className="step-n" aria-hidden>
        {state === "done" ? <Check size={15} strokeWidth={2.5} /> : n}
      </span>
      <div className="step-body">
        <div className="step-title-row">
          <h2 className="step-title">{title}</h2>
          {state === "done" && onEdit ? (
            <button type="button" className="link-btn" onClick={onEdit}>
              Change
            </button>
          ) : null}
        </div>
        {state === "done" && summary ? <p className="step-summary">{summary}</p> : null}
        {state === "current" ? <div className="step-content">{children}</div> : null}
      </div>
    </li>
  );
}

function InstallStep({
  instance,
  installing,
  progress,
  version,
  onError,
}: {
  instance: InstanceSummary;
  installing: boolean;
  progress: ReturnType<typeof useStore.getState>["progress"][string] | null;
  version: string | null;
  onError: (m: string) => void;
}) {
  const [starting, setStarting] = useState(false);
  const failed = progress?.task === "install" && progress.error;

  const run = async () => {
    setStarting(true);
    try {
      await api.install(instance.id);
    } catch (e) {
      onError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  if (installing && progress && !progress.error) {
    return (
      <div className="stack-tight install-live">
        <div className="install-top">
          <p className="progress-label">
            <Spinner /> {progress.label}
          </p>
          {progress.fraction !== null ? (
            <span className="install-pct">
              <CountUp value={progress.fraction * 100} />
              <span>%</span>
            </span>
          ) : null}
        </div>
        <Meter value={progress.fraction} />
        {progress.detail ? <p className="faint mono progress-detail">{progress.detail}</p> : null}
      </div>
    );
  }

  return (
    <div className="stack-tight">
      {instance.version ? (
        <p className="muted">
          ZDBF {instance.version} is already in <code className="selectable">{instance.path}</code>. The
          launcher sets up its own copy of Python 3.13 for it and installs the packages ZDBF needs. Your
          settings, token and data stay as they are.
        </p>
      ) : (
        <p className="muted">
          The launcher downloads ZDBF{version ? ` ${version}` : ""} from GitHub into{" "}
          <code className="selectable">{instance.path}</code> and sets up its own copy of Python 3.13 for it.
          Python on your computer, if you have one, is not touched. This needs an internet connection and
          takes a few minutes.
        </p>
      )}
      {failed ? (
        <Callout tone="bad" title="The installation stopped.">
          <p className="selectable">{progress?.error}</p>
          <p>Check your internet connection and try again. Files that were already downloaded are reused.</p>
        </Callout>
      ) : null}
      <div className="row">
        <Button variant="primary" onClick={run} busy={starting}>
          {failed ? "Try again" : "Install"}
        </Button>
      </div>
    </div>
  );
}

function TokenStep({ instanceId, onSaved }: { instanceId: string; onSaved: (t: TokenState) => void }) {
  const id = useId();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.setToken(instanceId, value.trim()));
      setValue("");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack-tight">
      <ol className="howto">
        <li>
          Open the{" "}
          <button type="button" className="link-btn" onClick={() => api.openUrl(PORTAL)}>
            Discord Developer Portal <ExternalLink size={13} aria-hidden />
          </button>{" "}
          and sign in. Press <strong>New Application</strong> and give it the bot's name, or open an existing
          application.
        </li>
        <li>
          Open <strong>Bot</strong> in the menu on the left and press <strong>Reset Token</strong>. Discord
          shows the token once.
        </li>
        <li>Copy it and paste it here.</li>
      </ol>
      <form
        className="token-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) void save();
        }}
      >
        <Field
          id={id}
          label="Bot token"
          error={error}
          hint="The token works like a password for your bot. It is saved only in this bot's .env file on this computer."
        >
          <SecretInput
            id={id}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Paste the token"
          />
        </Field>
        <div className="row">
          <Button variant="primary" type="submit" busy={busy} disabled={!value.trim()}>
            Save token
          </Button>
        </div>
      </form>
    </div>
  );
}

function IntentsStep({ token, onDone }: { token: TokenState | null; onDone: () => void }) {
  const [members, setMembers] = useState(false);
  const [content, setContent] = useState(false);
  const [invited, setInvited] = useState(false);
  const portal = token?.botId ? `${PORTAL}/${token.botId}/bot` : PORTAL;

  return (
    <div className="stack-tight">
      <p className="muted">
        ZDBF reads member lists and messages, so Discord asks you to allow that once. On the{" "}
        <button type="button" className="link-btn" onClick={() => api.openUrl(portal)}>
          Bot page of your application <ExternalLink size={13} aria-hidden />
        </button>
        , under Privileged Gateway Intents, turn these on and press Save Changes:
      </p>
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={members} onChange={(e) => setMembers(e.target.checked)} />
          <span>
            <strong>Server Members Intent</strong>
            <span className="faint"> for welcome messages, backups, levels and most automations</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={content} onChange={(e) => setContent(e.target.checked)} />
          <span>
            <strong>Message Content Intent</strong>
            <span className="faint"> for commands with the ! prefix and message triggers</span>
          </span>
        </label>
        <label className="check">
          <input type="checkbox" checked={invited} onChange={(e) => setInvited(e.target.checked)} />
          <span>
            <strong>The bot is in my server</strong>
            <span className="faint">
              {" "}
              {token?.inviteUrl ? "use the invite link below, pick your server and press Authorize" : ""}
            </span>
          </span>
        </label>
      </div>
      <div className="row">
        {token?.inviteUrl ? (
          <Button
            icon={<ExternalLink size={15} />}
            onClick={() => token.inviteUrl && api.openUrl(token.inviteUrl)}
          >
            Open the invite link
          </Button>
        ) : null}
        <Button variant="primary" disabled={!(members && content && invited)} onClick={onDone}>
          Continue
        </Button>
      </div>
      <p className="hint">
        The invite link gives the bot Administrator, which is simplest for your own server. You can change its
        role later in Discord.
      </p>
    </div>
  );
}

function StartStep({
  instance,
  status,
  onBackToToken,
  onBackToIntents,
}: {
  instance: InstanceSummary;
  status: BotStatus | null;
  onBackToToken: () => void;
  onBackToIntents: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const setInstances = useStore((s) => s.setInstances);
  const instances = useStore((s) => s.instances);
  const [busy, setBusy] = useState(false);
  const state = status?.state ?? instance.state;
  const exit = status?.lastExit;

  const start = async () => {
    setBusy(true);
    try {
      await api.start(instance.id);
    } catch (e) {
      toast("bad", errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    try {
      const updated = await api.finishSetup(instance.id);
      setInstances(instances.map((i) => (i.id === updated.id ? updated : i)));
    } catch (e) {
      toast("bad", errorText(e));
    }
  };

  if (state === "running") {
    return (
      <div className="stack-tight">
        <Callout tone="ok" title={`${status?.botUser ?? instance.name} is online.`}>
          {status?.guilds != null ? <p>It is in {plural(status.guilds, "server", "servers")}.</p> : null}
          <p>
            Type <code>/help</code> in your server. Slash commands can take a minute to show up the first
            time; <code>!help</code> works at once.
          </p>
        </Callout>
        <div className="row">
          <Button variant="primary" onClick={finish}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  if (state === "starting") {
    return (
      <p className="progress-label">
        <Spinner /> Starting and signing in to Discord.
      </p>
    );
  }

  return (
    <div className="stack-tight">
      {exit && state === "crashed" ? (
        <Callout tone="bad" title={EXIT_TEXT[exit.reason].title}>
          <p>{EXIT_TEXT[exit.reason].fix}</p>
          {exit.message ? <pre className="hero-detail selectable">{exit.message}</pre> : null}
        </Callout>
      ) : (
        <p className="muted">
          The first start creates config.toml with the default settings and the database.
        </p>
      )}
      <div className="row">
        {exit?.reason === "token_invalid" ? <Button onClick={onBackToToken}>Replace the token</Button> : null}
        {exit?.reason === "intents" ? (
          <Button onClick={onBackToIntents}>Back to the Discord settings</Button>
        ) : null}
        <Button variant="primary" onClick={start} busy={busy}>
          {exit ? "Start again" : "Start bot"}
        </Button>
      </div>
    </div>
  );
}
