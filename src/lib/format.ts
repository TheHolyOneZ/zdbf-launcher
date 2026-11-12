import type { BotState, BotStatus, ExitReason, Health } from "./api";

export const STATE_LABEL: Record<BotState, string> = {
  not_installed: "Not installed",
  installing: "Installing",
  stopped: "Stopped",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  crashed: "Stopped unexpectedly",
  waiting: "Restarting soon",
  updating: "Updating",
};

export type Tone = "ok" | "warn" | "bad" | "idle" | "busy";

export function stateTone(state: BotState, health?: Health | null): Tone {
  switch (state) {
    case "running":
      if (health === "critical") return "bad";
      if (health === "degraded") return "warn";
      return "ok";
    case "crashed":
      return "bad";
    case "starting":
    case "stopping":
    case "installing":
    case "updating":
    case "waiting":
      return "busy";
    default:
      return "idle";
  }
}

export const EXIT_TEXT: Record<ExitReason, { title: string; fix: string }> = {
  stopped: { title: "Stopped.", fix: "" },
  shutdown: { title: "The bot was shut down from Discord.", fix: "Start it again when you are ready." },
  token_missing: {
    title: "No bot token is set.",
    fix: "Paste your bot token in Settings, then start the bot.",
  },
  token_invalid: {
    title: "Discord did not accept the bot token.",
    fix: "In the Developer Portal open your application, then Bot, press Reset Token and paste the new token in Settings.",
  },
  intents: {
    title: "Discord refused the privileged intents.",
    fix: "In the Developer Portal open your application, then Bot, and turn on Server Members Intent and Message Content Intent. Then start the bot again.",
  },
  config: {
    title: "config.toml has a mistake.",
    fix: "Fix the setting named below in Settings, or open the file.",
  },
  python: {
    title: "The bot's Python environment is not working.",
    fix: "Use Repair in Settings to reinstall it. Your settings and data stay.",
  },
  crash: {
    title: "The bot stopped with an error.",
    fix: "The console shows the last error. Start the bot again, or turn on automatic restart.",
  },
  killed: {
    title: "The bot did not stop in time and was ended.",
    fix: "Your data is safe. Start the bot again.",
  },
};

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} d ${h} h`;
  if (h > 0) return `${h} h ${m} min`;
  if (m > 0) return `${m} min`;
  return `${s} s`;
}

export function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(ms: number): string {
  return new Date(ms).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function uptimeOf(status: BotStatus | null, now: number): number | null {
  if (status?.state !== "running" || !status.startedAt) return null;
  return (now - status.startedAt) / 1000;
}

export function isBusy(state: BotState): boolean {
  return (
    state === "starting" ||
    state === "stopping" ||
    state === "installing" ||
    state === "updating" ||
    state === "waiting"
  );
}

export function canStart(state: BotState): boolean {
  return state === "stopped" || state === "crashed" || state === "waiting";
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function stopwatch(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = `${pad(Math.floor((s % 86400) / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  return d > 0 ? `${d}d ${hms}` : hms;
}

export const BACKOFF = [5, 15, 60, 300];

export function backoffFor(attempt: number): number {
  return BACKOFF[Math.min(BACKOFF.length - 1, Math.max(0, attempt - 1))] ?? 5;
}
