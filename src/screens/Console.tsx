import { ArrowDownToLine, ChevronRight, Copy, Eraser, FolderOpen, Search } from "lucide-react";
import { memo, useDeferredValue, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SegThumb } from "../components/fx";
import { Button, Empty, IconButton } from "../components/ui";
import { api, type LogLine } from "../lib/api";
import { useCurrent, useCurrentStatus, useStore } from "../state/store";

type Filter = "all" | "info" | "warning" | "error";

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: "all", label: "All" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warnings" },
  { value: "error", label: "Errors" },
];

const RANK: Record<string, number> = { DEBUG: 0, INFO: 1, WARNING: 2, ERROR: 3, CRITICAL: 4 };

function passes(line: LogLine, filter: Filter): boolean {
  const r = RANK[line.level] ?? 1;
  if (filter === "all") return true;
  if (filter === "info") return r >= 1;
  if (filter === "warning") return r >= 2;
  return r >= 3;
}

function lineText(l: LogLine): string {
  const head = `${l.time} ${l.level.padEnd(8)} ${l.logger ? `${l.logger} ` : ""}${l.message}`;
  return l.trace.length ? `${head}\n${l.trace.join("\n")}` : head;
}

export function ConsoleScreen() {
  const current = useCurrent();
  const lines = useStore((s) => (current ? s.logs[current.id] : undefined));
  const setLogs = useStore((s) => s.setLogs);
  const toast = useStore((s) => s.toast);
  const [filter, setFilter] = useState<Filter>("info");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const box = useRef<HTMLDivElement>(null);
  const status = useCurrentStatus();
  const running = status?.state === "running" || status?.state === "starting";
  const mountSeq = useRef<number | null>(null);
  const pausedAt = useRef<number | null>(null);
  if (mountSeq.current === null && lines) mountSeq.current = lines[lines.length - 1]?.seq ?? 0;
  const lastSeq = lines?.[lines.length - 1]?.seq ?? 0;
  if (follow) pausedAt.current = null;
  else if (pausedAt.current === null) pausedAt.current = lastSeq;
  const unseen = !follow && pausedAt.current !== null ? Math.max(0, lastSeq - pausedAt.current) : 0;

  const shown = useMemo(() => {
    const all = lines ?? [];
    return all.filter(
      (l) =>
        passes(l, filter) &&
        (!deferredQuery ||
          l.message.toLowerCase().includes(deferredQuery) ||
          l.logger.toLowerCase().includes(deferredQuery) ||
          l.trace.some((t) => t.toLowerCase().includes(deferredQuery))),
    );
  }, [lines, filter, deferredQuery]);

  useLayoutEffect(() => {
    const el = box.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  });

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      setFollow(atBottom);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  if (!current) return null;

  const copyAll = async () => {
    await navigator.clipboard.writeText(shown.map(lineText).join("\n"));
    toast("ok", `Copied ${shown.length} lines. Tokens are already hidden.`);
  };

  return (
    <div className="console-screen">
      <div className="console-bar">
        <div className="seg" role="radiogroup" aria-label="Show">
          <SegThumb />
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              role="radio"
              aria-checked={filter === f.value}
              className="seg-item"
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="console-search">
          <Search size={15} aria-hidden />
          <span className="visually-hidden">Search the output</span>
          <input
            type="search"
            value={query}
            placeholder="Search"
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </label>
        <span className={`live-pill${follow && running ? "" : " is-paused"}`} aria-live="polite">
          <span className="live-dot" />
          {follow ? (running ? "Live" : "Idle") : "Paused"}
        </span>
        <div className="console-tools">
          <IconButton label="Copy what is shown" onClick={copyAll} disabled={!shown.length}>
            <Copy size={16} />
          </IconButton>
          <IconButton
            label="Clear the console"
            onClick={async () => {
              await api.clearConsole(current.id);
              setLogs(current.id, []);
            }}
          >
            <Eraser size={16} />
          </IconButton>
          <IconButton
            label="Open the logs folder"
            onClick={() => api.open(current.id, "logs").catch(() => undefined)}
          >
            <FolderOpen size={16} />
          </IconButton>
        </div>
      </div>

      <Minimap
        lines={shown}
        onPick={(seq) => {
          const el = box.current?.querySelector<HTMLElement>(`[data-seq="${seq}"]`);
          if (el) {
            setFollow(false);
            el.scrollIntoView({ block: "center", behavior: "smooth" });
            el.classList.remove("cl-pick");
            void el.offsetWidth;
            el.classList.add("cl-pick");
          }
        }}
      />
      <div className="console" ref={box} role="log" aria-live="off" aria-label="Bot output">
        {shown.length === 0 ? (
          <Empty title={lines?.length ? "Nothing matches." : "No output yet."}>
            {lines?.length
              ? "Change the filter or the search."
              : "Start the bot and its output shows up here, newest at the bottom."}
          </Empty>
        ) : (
          <ol className="console-lines selectable">
            {shown.map((l) => (
              <Row key={l.seq} line={l} query={deferredQuery} fresh={l.seq > (mountSeq.current ?? 0)} />
            ))}
          </ol>
        )}
      </div>

      {!follow && shown.length > 0 ? (
        <div className="console-follow">
          <Button
            size="sm"
            icon={<ArrowDownToLine size={15} />}
            onClick={() => {
              setFollow(true);
              const el = box.current;
              if (el) el.scrollTop = el.scrollHeight;
            }}
          >
            {unseen > 0 ? `${unseen} new, jump to the newest` : "Jump to the newest"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function mark(text: string, q: string) {
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return text;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Minimap({ lines, onPick }: { lines: LogLine[]; onPick: (seq: number) => void }) {
  const marks = useMemo(() => {
    const n = lines.length;
    if (n < 2) return [];
    const out: Array<{ seq: number; at: number; tone: "warn" | "bad" }> = [];
    lines.forEach((l, i) => {
      const r = RANK[l.level] ?? 1;
      if (r >= 2) out.push({ seq: l.seq, at: i / (n - 1), tone: r >= 3 ? "bad" : "warn" });
    });
    return out.slice(-160);
  }, [lines]);
  return (
    <div className="minimap">
      {marks.map((m) => (
        <button
          key={m.seq}
          type="button"
          className={`mm mm-${m.tone}`}
          style={{ left: `${m.at * 100}%` }}
          aria-label={m.tone === "bad" ? "Go to error" : "Go to warning"}
          onClick={() => onPick(m.seq)}
        />
      ))}
    </div>
  );
}

const Row = memo(function Row({ line, query, fresh }: { line: LogLine; query: string; fresh: boolean }) {
  const [open, setOpen] = useState(false);
  const level = line.level.toLowerCase();
  const time = line.time.length >= 19 ? line.time.slice(11, 19) : line.time;
  return (
    <li className={`cl cl-${level} cl-src-${line.source}${fresh ? " cl-new" : ""}`} data-seq={line.seq}>
      <span className="cl-time">{time}</span>
      <span className="cl-level">
        {line.level === "CRITICAL" ? "CRIT" : line.level === "WARNING" ? "WARN" : line.level}
      </span>
      <span className="cl-body">
        {line.logger ? <span className="cl-logger">{line.logger}</span> : null}
        <span className="cl-msg">{mark(line.message, query)}</span>
        {line.trace.length > 0 ? (
          <>
            <button type="button" className="cl-fold" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
              <ChevronRight size={13} aria-hidden />
              {open ? "Hide details" : `Show details (${line.trace.length} lines)`}
            </button>
            {open ? <pre className="cl-trace">{line.trace.join("\n")}</pre> : null}
          </>
        ) : null}
      </span>
    </li>
  );
});
