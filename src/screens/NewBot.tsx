import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { RollText, SegThumb } from "../components/fx";
import { Core, type CoreHandle, Mark } from "../components/Mark";
import { Pulse } from "../components/Pulse";
import { Button, Field, TextInput } from "../components/ui";
import { api, errorText } from "../lib/api";
import { emitSignal, setSignalOrigin } from "../lib/motion";
import { useStore } from "../state/store";

export function NewBotScreen() {
  const instances = useStore((s) => s.instances);
  const setInstances = useStore((s) => s.setInstances);
  const select = useStore((s) => s.select);
  const go = useStore((s) => s.go);
  const first = instances.length === 0;
  const nameId = useId();
  const pathId = useId();
  const [mode, setMode] = useState<"new" | "import">("new");
  const [name, setName] = useState(first ? "My bot" : "");
  const [path, setPath] = useState("");
  const [pathTouched, setPathTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (pathTouched || mode === "import") return;
    const n = name.trim() || "bot";
    api
      .suggestPath(n)
      .then(setPath)
      .catch(() => undefined);
  }, [name, pathTouched, mode]);

  const browse = async () => {
    const picked = await openDialog({
      directory: true,
      multiple: false,
      title: mode === "import" ? "Choose the ZDBF folder" : "Choose a folder for the bot",
    });
    if (typeof picked === "string") {
      setPath(picked);
      setPathTouched(true);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const created =
        mode === "new"
          ? await api.createInstance(name.trim(), path.trim())
          : await api.importInstance(name.trim(), path.trim());
      setInstances([...instances, created]);
      select(created.id);
      go("overview");
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <>
      {first ? (
        <div className="welcome">
          <RollText as="h1" className="welcome-title" text="Run your own ZDBF bot" stretch />
          <p className="page-lead" data-reveal>
            The launcher installs ZDBF, keeps it running and updates it for you. No Python or command line
            needed.
          </p>
        </div>
      ) : (
        <header className="page-head">
          <div>
            <h1 className="page-title">Add a bot</h1>
            <p className="page-lead">Each bot has its own folder, token and settings.</p>
          </div>
        </header>
      )}

      <div className="seg" role="radiogroup" aria-label="How to add the bot">
        <SegThumb />
        <button
          type="button"
          role="radio"
          aria-checked={mode === "new"}
          className="seg-item"
          onClick={() => {
            setMode("new");
            setPathTouched(false);
          }}
        >
          Install a new bot
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "import"}
          className="seg-item"
          onClick={() => {
            setMode("import");
            setPath("");
          }}
        >
          Use a bot I already installed
        </button>
      </div>

      <form
        className="newbot-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          id={nameId}
          label="Name"
          hint="Only for you, to tell your bots apart. Discord shows the name from the Developer Portal."
        >
          <TextInput
            id={nameId}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={40}
            required
          />
        </Field>
        <Field
          id={pathId}
          label={mode === "new" ? "Folder" : "ZDBF folder"}
          error={error}
          hint={
            mode === "new"
              ? "ZDBF, its settings and its data go here. The folder must be empty or not exist yet."
              : "The folder that contains pyproject.toml and the zdbf folder. Your settings, token and data stay as they are."
          }
        >
          <div className="row nowrap">
            <TextInput
              id={pathId}
              className="mono"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setPathTouched(true);
              }}
              spellCheck={false}
              required
            />
            <Button icon={<FolderOpen size={16} />} onClick={browse}>
              Choose
            </Button>
          </div>
        </Field>
        <div className="row">
          <Button variant="primary" type="submit" busy={busy} disabled={!name.trim() || !path.trim()}>
            {mode === "new" ? "Continue" : "Add this bot"}
          </Button>
        </div>
      </form>
    </>
  );

  if (!first) return <div className="newbot">{form}</div>;

  return (
    <div className="firstrun">
      <div className="firstrun-form">
        <Mark size={36} />
        {form}
      </div>
      <BootShow />
    </div>
  );
}

const CYCLE = 9000;
const SHOW_STEPS = ["Download ZDBF", "Set up Python", "Add your token", "Online"];

function BootShow() {
  const [stage, setStage] = useState(0);
  const core = useRef<CoreHandle>(null);
  useEffect(() => {
    setSignalOrigin(core.current?.element() ?? null);
    let timers: number[] = [];
    const run = () => {
      for (const t of timers) window.clearTimeout(t);
      setStage(0);
      timers = [1, 2, 3, 4].map((n) => window.setTimeout(() => setStage(n), 350 + n * 700));
      for (let k = 0; k < 6; k++) {
        timers.push(
          window.setTimeout(
            () => emitSignal({ tone: "ok", strength: 0.4 + Math.random() * 0.5 }),
            3700 + k * 750 + Math.random() * 300,
          ),
        );
      }
    };
    run();
    const loop = window.setInterval(run, CYCLE);
    return () => {
      window.clearInterval(loop);
      for (const t of timers) window.clearTimeout(t);
      setSignalOrigin(null);
    };
  }, []);
  const online = stage >= 4;
  return (
    <div className="firstrun-show" aria-hidden>
      <div className="firstrun-grid" />
      <div className="firstrun-core">
        <Core
          tone={online ? "ok" : "busy"}
          stage={stage}
          size={340}
          ring={stage / 4}
          ringMode="uptime"
          handle={core}
          listen
        />
      </div>
      <div className="firstrun-pulse">
        <Pulse tone={online ? "ok" : "busy"} height={110} fade={[0.2, 0.8]} />
      </div>
      <p className="firstrun-caption">What the launcher does next</p>
      <ul className="firstrun-steps">
        {SHOW_STEPS.map((label, i) => (
          <li key={label} className={stage === i + 1 ? "is-now" : undefined}>
            <span className="firstrun-tick" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
