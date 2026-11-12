import { ExternalLink, FileCode2, FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button, Callout, Empty, IconButton, PageHead, Spinner, Toggle } from "../components/ui";
import { api, type ExtensionInfo, errorText } from "../lib/api";
import { useCurrent, useCurrentStatus, useStore } from "../state/store";

const MARKETPLACE = "https://zsync.eu/extension/";

export function ExtensionsScreen() {
  const current = useCurrent();
  const status = useCurrentStatus();
  const toast = useStore((s) => s.toast);
  const [list, setList] = useState<ExtensionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [changed, setChanged] = useState(false);

  const load = useCallback(async () => {
    if (!current) return;
    setError(null);
    try {
      setList(await api.listExtensions(current.id));
    } catch (e) {
      setError(errorText(e));
    }
  }, [current]);

  useEffect(() => {
    setList(null);
    setChanged(false);
    void load();
  }, [load]);

  if (!current) return null;
  const running = (status?.state ?? current.state) === "running";

  const toggle = async (ext: ExtensionInfo, enabled: boolean) => {
    setBusy(ext.name);
    try {
      const res = await api.setExtensionEnabled(current.id, ext.name, enabled);
      if (!res.ok) {
        toast("bad", res.errors.join(" "));
      } else {
        setChanged(true);
        await load();
      }
    } catch (e) {
      toast("bad", errorText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="narrow-wide">
      <PageHead
        title="Extensions"
        lead="Python files in the extensions folder add commands and features. Turn one off and the bot no longer loads it on start."
        actions={
          <>
            <IconButton label="Read the folder again" onClick={load}>
              <RefreshCw size={17} />
            </IconButton>
            <Button icon={<FolderOpen size={16} />} onClick={() => api.open(current.id, "extensions")}>
              Open the folder
            </Button>
          </>
        }
      />

      {changed && running ? (
        <Callout
          tone="info"
          title="Saved. The change applies when the bot restarts."
          action={
            <Button
              size="sm"
              variant="primary"
              onClick={() => api.restart(current.id).catch((e) => toast("bad", errorText(e)))}
            >
              Restart bot
            </Button>
          }
        >
          In Discord, /ext load and /ext unload change it right away without a restart.
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="bad" title="The extensions folder could not be read.">
          <p className="selectable">{error}</p>
        </Callout>
      ) : list === null ? (
        <p className="progress-label">
          <Spinner /> Reading the extensions folder
        </p>
      ) : list.length === 0 ? (
        <Empty
          title="No extensions yet."
          action={
            <Button icon={<ExternalLink size={15} />} onClick={() => api.openUrl(MARKETPLACE)}>
              Browse the ZSync Marketplace
            </Button>
          }
        >
          Put a .py file into the extensions folder, or install one with /marketplace in Discord.
        </Empty>
      ) : (
        <ul className="ext-list">
          {list.map((ext) => (
            <li key={ext.file} className={`ext panel spot${ext.enabled ? "" : " is-off"}`}>
              <HexBadge name={ext.name} on={ext.enabled} />
              <div className="ext-main">
                <div className="ext-title">
                  <span className="ext-name">{ext.name}</span>
                  {ext.version ? <span className="tag mono">v{ext.version}</span> : null}
                  {ext.example ? <span className="tag">example from ZDBF</span> : null}
                  {ext.isPackage ? <span className="tag">folder</span> : null}
                </div>
                <p className="ext-desc">
                  {ext.description ?? <span className="faint">No description.</span>}
                </p>
                {ext.author ? <p className="faint ext-author">by {ext.author}</p> : null}
              </div>
              <div className="ext-actions">
                <IconButton
                  label={`Open ${ext.file}`}
                  onClick={() =>
                    api.openExtension(current.id, ext.file).catch((e) => toast("bad", errorText(e)))
                  }
                >
                  <FileCode2 size={17} />
                </IconButton>
                <div className="ext-toggle">
                  <Toggle
                    checked={ext.enabled}
                    disabled={busy !== null}
                    onChange={(v) => toggle(ext, v)}
                    label={<span className="visually-hidden">Load {ext.name}</span>}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {list && list.length > 0 ? (
        <section className="market panel spot" data-reveal>
          <div>
            <h2 className="market-title">More extensions</h2>
            <p className="muted">
              The ZSync Marketplace has community extensions. Install them with /marketplace in Discord; the
              bot checks each one before it installs.
            </p>
          </div>
          <Button icon={<ExternalLink size={15} />} onClick={() => api.openUrl(MARKETPLACE)}>
            Browse the marketplace
          </Button>
        </section>
      ) : null}
    </div>
  );
}

function HexBadge({ name, on }: { name: string; on: boolean }) {
  const letters = name
    .replace(/[^A-Za-z0-9 _-]/g, "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <svg className={`hexbadge${on ? " is-on" : ""}`} width="44" height="44" viewBox="0 0 100 100" aria-hidden>
      <path d="M50 4 L90 27 L90 73 L50 96 L10 73 L10 27 Z" className="hexbadge-shape" />
      <text x="50" y="52" textAnchor="middle" dominantBaseline="middle" className="hexbadge-text">
        {letters || "X"}
      </text>
    </svg>
  );
}
