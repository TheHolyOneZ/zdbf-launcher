import { FileCog, FolderOpen, RotateCcw, Wrench } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { Dialog } from "../components/Dialog";
import { Button, Callout, CopyLine, Field, SecretInput, Spinner, TextInput, Toggle } from "../components/ui";
import {
  api,
  type ConfigField,
  type ConfigSnapshot,
  errorText,
  type InstanceSummary,
  type TokenState,
} from "../lib/api";
import { type FieldDef, KNOWN_KEYS, MODULES, SECTIONS } from "../lib/configSchema";
import { useBotActions } from "../state/actions";
import { useCurrent, useCurrentStatus, useStore } from "../state/store";

type Draft = Record<string, unknown>;

const NAV = [
  { id: "bot", title: "This bot" },
  { id: "token", title: "Bot token" },
  { id: "modules", title: "Modules" },
  ...SECTIONS.map((s) => ({ id: s.id, title: s.title })),
  { id: "file", title: "The file" },
];

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function display(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(", ") : "nothing";
  if (typeof v === "boolean") return v ? "on" : "off";
  if (v === null || v === undefined) return "not set";
  return String(v);
}

export function SettingsScreen() {
  const current = useCurrent();
  const status = useCurrentStatus();
  const toast = useStore((s) => s.toast);
  const [snap, setSnap] = useState<ConfigSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[] | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const actions = useBotActions(current?.id ?? null);
  const [spy, setSpy] = useState<string>(NAV[0]?.id ?? "");

  useEffect(() => {
    const root = document.getElementById("content");
    if (!root || !snap) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id.slice(2), e.isIntersecting);
        const first = NAV.find((n) => seen.get(n.id));
        if (first) setSpy(first.id);
      },
      { root, rootMargin: "0px 0px -65% 0px" },
    );
    for (const n of NAV) {
      const el = document.getElementById(`s-${n.id}`);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [snap]);

  const load = useCallback(async () => {
    if (!current) return;
    try {
      setSnap(await api.readConfig(current.id));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [current]);

  useEffect(() => {
    setDraft({});
    setErrors([]);
    setSaved(null);
    void load();
  }, [load]);

  const byKey = useMemo(() => {
    const m = new Map<string, ConfigField>();
    for (const f of snap?.fields ?? []) m.set(f.key, f);
    return m;
  }, [snap]);

  if (!current) return null;
  const running = (status?.state ?? current.state) === "running" || status?.state === "starting";

  const currentValue = (key: string): unknown => (key in draft ? draft[key] : byKey.get(key)?.value);
  const set = (key: string, v: unknown) => {
    setSaved(null);
    setDraft((d) => {
      const next = { ...d };
      if (same(v, byKey.get(key)?.value)) delete next[key];
      else next[key] = v;
      return next;
    });
  };

  const invalid = Object.entries(draft).filter(([, v]) => typeof v === "string" && v.startsWith("\u0000"));
  const dirty = Object.keys(draft).length;

  const save = async () => {
    setSaving(true);
    setErrors([]);
    try {
      const res = await api.saveConfig(current.id, draft);
      if (res.ok) {
        setDraft({});
        setSaved(res.restart);
        await load();
      } else {
        setErrors(res.errors);
      }
    } catch (e) {
      setErrors([errorText(e)]);
    } finally {
      setSaving(false);
    }
  };

  const removeOverride = async (key: string) => {
    try {
      setSnap(await api.removeOverride(current.id, key));
      toast("ok", "The change from Discord is removed. The value from the file applies on the next start.");
    } catch (e) {
      toast("bad", errorText(e));
    }
  };

  const overrideNote = (key: string) => {
    const f = byKey.get(key);
    if (!f?.hasOverride) return null;
    return (
      <div className="override">
        <span>
          Changed in Discord to <strong>{display(f.override)}</strong>. That value wins over this one.
        </span>
        {running ? (
          <span className="faint">Stop the bot to undo it here.</span>
        ) : (
          <button type="button" className="link-btn" onClick={() => removeOverride(key)}>
            Use the value from here
          </button>
        )}
      </div>
    );
  };

  const fieldErrors = new Map<string, string>();
  for (const e of errors) {
    const m = /^([a-z_]+(?:\.[a-z_]+)+)(?:\.\d+)?: (?:Value error, )?(.*)$/.exec(e);
    if (m?.[1] && m[2]) fieldErrors.set(m[1], m[2]);
  }

  const otherOverrides = (snap?.fields ?? []).filter((f) => f.hasOverride && !KNOWN_KEYS.has(f.key));

  return (
    <div className="settings">
      <nav className="subnav" aria-label="Settings sections">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={`#s-${n.id}`}
            className={spy === n.id ? "is-active" : undefined}
            onClick={(e) => {
              e.preventDefault();
              document.getElementById(`s-${n.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
          >
            {n.title}
          </a>
        ))}
      </nav>

      <div className="settings-body">
        <BotSection instance={current} running={running} />
        <TokenSection instance={current} running={running} onRestart={actions.restart} />

        {loadError ? (
          <Callout tone="bad" title="The settings could not be read.">
            <p className="selectable">{loadError}</p>
          </Callout>
        ) : !snap ? (
          <p className="progress-label">
            <Spinner /> Reading config.toml
          </p>
        ) : (
          <>
            {!snap.exists ? (
              <Callout tone="info" title="config.toml does not exist yet.">
                The bot creates it on its first start. These are the default values; saving creates the file
                now.
              </Callout>
            ) : null}

            <section className="section" id="s-modules">
              <h2 className="section-title">Modules</h2>
              <p className="section-lead">
                Turn whole features on or off. Off means their commands do not exist.
              </p>
              <div className="toggles">
                {MODULES.map((m) => {
                  const key = `modules.${m.key}`;
                  const v = currentValue(key);
                  const on = typeof v === "boolean" ? v : !(m.key === "cluster" || m.key === "dashboard");
                  return (
                    <div key={m.key} className="toggle-block">
                      <Toggle
                        checked={m.locked ? true : on}
                        disabled={m.locked}
                        onChange={(next) => set(key, next)}
                        label={m.label}
                        description={m.help}
                      />
                      {overrideNote(key)}
                    </div>
                  );
                })}
              </div>
            </section>

            {SECTIONS.map((sec) => {
              const fields = sec.fields.filter((f) => showAdvanced || !f.advanced || f.key in draft);
              const hidden = sec.fields.length - fields.length;
              return (
                <section key={sec.id} className="section" id={`s-${sec.id}`}>
                  <h2 className="section-title">{sec.title}</h2>
                  <p className="section-lead">{sec.lead}</p>
                  <div className="fields">
                    {fields.map((f) => (
                      <div key={f.key} className="field-block">
                        <FieldInput
                          def={f}
                          value={currentValue(f.key)}
                          present={byKey.has(f.key)}
                          onChange={(v) => set(f.key, v)}
                        />
                        {fieldErrors.has(f.key) ? (
                          <p className="field-error" role="alert">
                            {fieldErrors.get(f.key)}
                          </p>
                        ) : null}
                        {overrideNote(f.key)}
                      </div>
                    ))}
                  </div>
                  {hidden > 0 ? (
                    <button type="button" className="link-btn more-btn" onClick={() => setShowAdvanced(true)}>
                      Show {hidden} more
                    </button>
                  ) : null}
                </section>
              );
            })}

            <section className="section" id="s-file">
              <h2 className="section-title">The file</h2>
              <p className="section-lead">
                Everything here is saved to config.toml with its comments and layout kept. Settings for
                extensions and the status texts are edited in the file itself.
              </p>
              {snap.unknownSections.length > 0 ? (
                <p className="muted">
                  Sections from extensions: <span className="mono">{snap.unknownSections.join(", ")}</span>
                </p>
              ) : null}
              {otherOverrides.length > 0 ? (
                <div className="stack-tight other-overrides">
                  <p className="muted">Other changes made in Discord:</p>
                  {otherOverrides.map((f) => (
                    <div key={f.key} className="override">
                      <span>
                        <span className="mono">{f.key}</span> = <strong>{display(f.override)}</strong>
                      </span>
                      {running ? null : (
                        <button type="button" className="link-btn" onClick={() => removeOverride(f.key)}>
                          Remove
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ) : null}
              <div className="row">
                <Button
                  icon={<FileCog size={16} />}
                  onClick={() => api.open(current.id, "config").catch((e) => toast("bad", errorText(e)))}
                >
                  Open config.toml
                </Button>
                <Button
                  icon={<FolderOpen size={16} />}
                  variant="quiet"
                  onClick={() => api.open(current.id, "folder")}
                >
                  Open the bot folder
                </Button>
              </div>
              <p className="hint mono selectable">{snap.path}</p>
            </section>
          </>
        )}
      </div>

      {dirty > 0 || errors.length > 0 || saved ? (
        <div
          className={`savebar${errors.length ? " has-errors" : ""}`}
          role="region"
          aria-label="Unsaved changes"
        >
          {errors.length ? (
            <div className="savebar-errors" role="alert">
              <p className="callout-title">The bot would not accept these settings.</p>
              <ul>
                {errors.map((e) => (
                  <li key={e} className="selectable">
                    {e}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="savebar-row">
            {saved && dirty === 0 ? (
              <>
                <span>
                  Saved.{" "}
                  {running
                    ? saved.length
                      ? "Restart the bot to use the new settings."
                      : "Restart the bot, or run /fw config reload in Discord, to use them."
                    : "They apply when the bot starts."}
                </span>
                <div className="row">
                  {running ? (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<RotateCcw size={15} />}
                      onClick={actions.restart}
                    >
                      Restart bot
                    </Button>
                  ) : null}
                  <Button size="sm" variant="quiet" onClick={() => setSaved(null)}>
                    Close
                  </Button>
                </div>
              </>
            ) : (
              <>
                <span>
                  {dirty === 1 ? "1 change" : `${dirty} changes`} not saved.
                  {invalid.length ? " Fix the marked fields first." : ""}
                </span>
                <div className="row">
                  <Button
                    size="sm"
                    variant="quiet"
                    onClick={() => {
                      setDraft({});
                      setErrors([]);
                    }}
                  >
                    Discard
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={save}
                    busy={saving}
                    disabled={invalid.length > 0 || dirty === 0}
                  >
                    Save
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FieldInput({
  def,
  value,
  present,
  onChange,
}: {
  def: FieldDef;
  value: unknown;
  present: boolean;
  onChange: (v: unknown) => void;
}) {
  const id = useId();
  const label = (
    <>
      {def.label}
      {def.restart ? <span className="tag">restart</span> : null}
    </>
  );
  const hint = def.help || undefined;

  if (def.kind === "bool") {
    return <Toggle checked={value === true} onChange={onChange} label={label} description={hint} />;
  }

  if (def.kind === "multi") {
    const list = Array.isArray(value) ? (value as string[]) : [];
    return (
      <fieldset className="multi">
        <legend className="field-label">{label}</legend>
        {hint ? <p className="hint">{hint}</p> : null}
        <div className="multi-grid">
          {(def.options ?? []).map((o) => (
            <label key={o.value} className="check">
              <input
                type="checkbox"
                checked={list.includes(o.value)}
                onChange={(e) => {
                  const next = e.target.checked ? [...list, o.value] : list.filter((x) => x !== o.value);
                  const order = (def.options ?? []).map((x) => x.value);
                  next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
                  onChange(next);
                }}
              />
              <span>
                <span className="check-label">{o.label}</span>
                {o.hint ? <span className="faint check-hint">{o.hint}</span> : null}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    );
  }

  if (def.kind === "choice") {
    return (
      <Field id={id} label={label} hint={hint}>
        <select
          id={id}
          className="input input-short"
          value={String(value ?? "")}
          onChange={(e) => onChange(e.target.value)}
        >
          {(def.options ?? []).map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>
    );
  }

  if (def.kind === "int" || def.kind === "float") {
    return <NumberInput def={def} value={value} onChange={onChange} id={id} label={label} hint={hint} />;
  }

  if (def.kind === "ids" || def.kind === "tags") {
    return <ListInput def={def} value={value} onChange={onChange} id={id} label={label} hint={hint} />;
  }

  return (
    <Field id={id} label={label} hint={!present ? "Not in the file yet. The bot uses its default." : hint}>
      <TextInput
        id={id}
        value={typeof value === "string" ? value : ""}
        placeholder={def.placeholder}
        list={def.kind === "timezone" ? "tz-list" : undefined}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className={def.kind === "timezone" ? "input-mid" : def.short ? "input-short" : undefined}
      />
      {def.kind === "timezone" ? <TimezoneList /> : null}
    </Field>
  );
}

let tzCache: string[] | null = null;
function TimezoneList() {
  if (!tzCache) {
    try {
      tzCache = (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf(
        "timeZone",
      );
    } catch {
      tzCache = ["UTC"];
    }
  }
  return (
    <datalist id="tz-list">
      {tzCache.map((z) => (
        <option key={z} value={z} />
      ))}
    </datalist>
  );
}

const BAD = "\u0000";

function NumberInput({
  def,
  value,
  onChange,
  id,
  label,
  hint,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  label: ReactNode;
  hint?: string;
}) {
  const raw =
    typeof value === "string"
      ? value.replace(BAD, "")
      : value === undefined || value === null
        ? ""
        : String(value);
  const isBad = typeof value === "string" && value.startsWith(BAD);
  const limits =
    def.min !== undefined && def.max !== undefined
      ? `Between ${def.min} and ${def.max}.`
      : def.min !== undefined
        ? `At least ${def.min}.`
        : "";
  return (
    <Field id={id} label={label} hint={hint} error={isBad ? `Enter a number. ${limits}` : undefined}>
      <div className="with-unit">
        <TextInput
          id={id}
          inputMode={def.kind === "int" ? "numeric" : "decimal"}
          className="input-short"
          value={raw}
          onChange={(e) => {
            const t = e.target.value.trim().replace(",", ".");
            const n = def.kind === "int" ? Number.parseInt(t, 10) : Number.parseFloat(t);
            const ok =
              t !== "" &&
              /^-?\d+(\.\d+)?$/.test(t) &&
              !(def.kind === "int" && t.includes(".")) &&
              (def.min === undefined || n >= def.min) &&
              (def.max === undefined || n <= def.max);
            onChange(ok ? n : BAD + e.target.value);
          }}
        />
        {def.unit ? <span className="unit">{def.unit}</span> : null}
      </div>
    </Field>
  );
}

function ListInput({
  def,
  value,
  onChange,
  id,
  label,
  hint,
}: {
  def: FieldDef;
  value: unknown;
  onChange: (v: unknown) => void;
  id: string;
  label: ReactNode;
  hint?: string;
}) {
  const initial = Array.isArray(value)
    ? (value as unknown[]).join(", ")
    : typeof value === "string"
      ? value.replace(BAD, "")
      : "";
  const [text, setText] = useState(initial);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (!touched) setText(initial);
  }, [initial, touched]);
  const isBad = typeof value === "string" && value.startsWith(BAD);
  return (
    <Field
      id={id}
      label={label}
      hint={hint ? `${hint} Separate several with commas.` : "Separate several with commas."}
      error={isBad ? "Discord IDs are long numbers, for example 123456789012345678." : undefined}
    >
      <TextInput
        id={id}
        className="mono"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setTouched(true);
          setText(e.target.value);
          const parts = e.target.value
            .split(/[,\s]+/)
            .map((p) => p.trim())
            .filter(Boolean);
          if (def.kind === "ids") {
            if (parts.every((p) => /^\d{15,21}$/.test(p))) onChange(parts.map((p) => Number(p)));
            else onChange(BAD + e.target.value);
          } else {
            onChange(parts);
          }
        }}
      />
    </Field>
  );
}

function BotSection({ instance, running }: { instance: InstanceSummary; running: boolean }) {
  const toast = useStore((s) => s.toast);
  const setInstances = useStore((s) => s.setInstances);
  const instances = useStore((s) => s.instances);
  const nameId = useId();
  const [name, setName] = useState(instance.name);
  const [confirm, setConfirm] = useState<"remove" | "repair" | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setName(instance.name), [instance.name]);

  const replace = (u: InstanceSummary) => setInstances(instances.map((i) => (i.id === u.id ? u : i)));
  const option = async (o: { autoRestart?: boolean; startWithLauncher?: boolean }) => {
    try {
      replace(await api.setInstanceOptions(instance.id, o));
    } catch (e) {
      toast("bad", errorText(e));
    }
  };

  return (
    <section className="section" id="s-bot">
      <h2 className="section-title">This bot</h2>
      <div className="fields">
        <Field
          id={nameId}
          label="Name in the launcher"
          hint="Only for you. Discord shows the name from the Developer Portal."
        >
          <div className="row nowrap">
            <TextInput id={nameId} value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
            <Button
              disabled={!name.trim() || name.trim() === instance.name}
              onClick={async () => {
                try {
                  replace(await api.renameInstance(instance.id, name));
                } catch (e) {
                  toast("bad", errorText(e));
                }
              }}
            >
              Rename
            </Button>
          </div>
        </Field>
        <Toggle
          checked={instance.autoRestart}
          onChange={(v) => option({ autoRestart: v })}
          label="Restart after a crash"
          description="Waits 5 seconds, then 15, 60 and 5 minutes between attempts. A wrong token or a broken config.toml is never retried."
        />
        <Toggle
          checked={instance.startWithLauncher}
          onChange={(v) => option({ startWithLauncher: v })}
          label="Start with the launcher"
          description="Starts this bot whenever the launcher opens. Turn on Open the launcher when I sign in under Launcher to have it start with your computer."
        />
        <dl className="kv">
          <dt>Folder</dt>
          <dd className="kv-path">
            <CopyLine text={instance.path} label="Copy the folder path" />
          </dd>
          <dt>ZDBF</dt>
          <dd>{instance.version ?? "unknown"}</dd>
        </dl>
        <div className="row row-split">
          <Button icon={<Wrench size={16} />} onClick={() => setConfirm("repair")} disabled={running}>
            Repair Python
          </Button>
          <Button variant="danger" onClick={() => setConfirm("remove")}>
            Remove from the launcher
          </Button>
        </div>
      </div>
      <Dialog
        open={confirm === "repair"}
        title="Repair the Python environment?"
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="primary"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.repair(instance.id);
                  toast("ok", "The Python environment is repaired.");
                  setConfirm(null);
                } catch (e) {
                  toast("bad", errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Repair
            </Button>
          </>
        }
      >
        <p>
          The launcher creates the Python environment again and reinstalls the packages ZDBF needs. Settings,
          token, data and extensions stay. Packages that marketplace extensions installed have to be installed
          again; the bot offers that when it loads them.
        </p>
      </Dialog>
      <Dialog
        open={confirm === "remove"}
        title={`Remove ${instance.name} from the launcher?`}
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              busy={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.removeInstance(instance.id);
                  setConfirm(null);
                } catch (e) {
                  toast("bad", errorText(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              Remove
            </Button>
          </>
        }
      >
        <p>
          {running ? "The bot is stopped first. " : ""}Nothing is deleted: the folder stays on your computer
          with its settings, token and data.
        </p>
        <p className="mono selectable">{instance.path}</p>
        <p>To use it again later, choose Add a bot, then Use a bot I already installed.</p>
      </Dialog>
    </section>
  );
}

function TokenSection({
  instance,
  running,
  onRestart,
}: {
  instance: InstanceSummary;
  running: boolean;
  onRestart: () => void;
}) {
  const id = useId();
  const [state, setState] = useState<TokenState | null>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    api
      .tokenState(instance.id)
      .then(setState)
      .catch(() => setState(null));
  }, [instance.id]);

  return (
    <section className="section" id="s-token">
      <h2 className="section-title">Bot token</h2>
      <p className="section-lead">Saved in this bot's .env file. The launcher never shows it again.</p>
      <div className="stack-tight">
        {state?.set ? (
          <dl className="kv">
            <dt>Token</dt>
            <dd className="mono">•••••••••••••••••••• for the bot with ID {state.botId ?? "unknown"}</dd>
          </dl>
        ) : (
          <Callout tone="warn" title="No token is set." />
        )}
        {state?.inviteUrl ? (
          <div className="stack-tight">
            <p className="field-label">Invite link</p>
            <CopyLine text={state.inviteUrl} label="Copy the invite link" />
          </div>
        ) : null}
        {changed && running ? (
          <Callout
            tone="info"
            title="The new token is used after a restart."
            action={
              <Button size="sm" variant="primary" onClick={onRestart}>
                Restart bot
              </Button>
            }
          />
        ) : null}
        {editing ? (
          <form
            className="token-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                setState(await api.setToken(instance.id, value.trim()));
                setValue("");
                setEditing(false);
                setChanged(true);
              } catch (err) {
                setError(errorText(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            <Field
              id={id}
              label="New bot token"
              error={error}
              hint="Developer Portal, your application, Bot, Reset Token."
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
              <Button variant="quiet" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="row">
            <Button onClick={() => setEditing(true)}>
              {state?.set ? "Replace the token" : "Add a token"}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
