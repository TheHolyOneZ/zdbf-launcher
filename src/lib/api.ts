import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type BotState =
  | "not_installed"
  | "installing"
  | "stopped"
  | "starting"
  | "running"
  | "stopping"
  | "crashed"
  | "waiting"
  | "updating";

export type Health = "healthy" | "degraded" | "critical";

export type ExitReason =
  | "stopped"
  | "shutdown"
  | "token_missing"
  | "token_invalid"
  | "intents"
  | "config"
  | "python"
  | "crash"
  | "killed";

export type ThemePref = "system" | "dark" | "light";

export interface AppInfo {
  version: string;
  os: "linux" | "windows" | "macos";
  arch: string;
  dataDir: string;
  defaultInstallRoot: string;
}

export interface Prefs {
  theme: ThemePref;
  closeToTray: boolean;
  launchAtLogin: boolean;
  checkLauncherUpdates: boolean;
  lastInstance: string | null;
}

export interface InstanceSummary {
  id: string;
  name: string;
  path: string;
  version: string | null;
  state: BotState;
  health: Health | null;
  autoRestart: boolean;
  startWithLauncher: boolean;
  botId: string | null;
  setupDone: boolean;
}

export interface ExitInfo {
  code: number | null;
  reason: ExitReason;
  message: string;
  at: number;
}

export interface Diagnostics {
  generatedAt: string;
  status: Health;
  uptimeSeconds: number;
  botUser: string | null;
  botId: string | null;
  latencyMs: number | null;
  guilds: number | null;
  version: string | null;
  python: string | null;
  discordPy: string | null;
  extensionsLoaded: number;
  extensionsFailed: string[];
  stale: boolean;
}

export interface BotStatus {
  id: string;
  state: BotState;
  pid: number | null;
  startedAt: number | null;
  readyAt: number | null;
  botUser: string | null;
  guilds: number | null;
  lastExit: ExitInfo | null;
  restartAt: number | null;
  restartAttempt: number;
  diagnostics: Diagnostics | null;
  dashboardRunning: boolean;
}

export type LogLevel = "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL";

export interface LogLine {
  seq: number;
  time: string;
  level: LogLevel;
  logger: string;
  message: string;
  trace: string[];
  source: "log" | "output" | "launcher";
}

export interface Progress {
  id: string;
  task: "install" | "update" | "dashboard" | "repair";
  step: string;
  label: string;
  detail: string | null;
  fraction: number | null;
  done: boolean;
  error: string | null;
}

export interface TokenState {
  set: boolean;
  botId: string | null;
  inviteUrl: string | null;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  name: string;
  publishedAt: string;
  notes: string;
  url: string;
}

export interface ReleaseCheck {
  latest: ReleaseInfo | null;
  checkedAt: number | null;
  rateLimitedUntil: number | null;
  offline: boolean;
  error: string | null;
}

export interface UpdatePlan {
  current: string | null;
  latest: ReleaseInfo | null;
  available: boolean;
  changedByYou: string[];
  removedUpstream: number;
}

export interface BackupInfo {
  name: string;
  version: string | null;
  createdAt: number;
  sizeBytes: number;
}

export type FieldKind = "bool" | "int" | "float" | "string" | "enum" | "list" | "table";

export interface ConfigField {
  key: string;
  value: unknown;
  inFile: boolean;
  override: unknown;
  hasOverride: boolean;
}

export interface ConfigSnapshot {
  path: string;
  exists: boolean;
  fields: ConfigField[];
  unknownSections: string[];
  overridesPath: string;
}

export interface SaveResult {
  ok: boolean;
  errors: string[];
  restart: string[];
}

export interface ExtensionInfo {
  name: string;
  file: string;
  isPackage: boolean;
  version: string | null;
  description: string | null;
  author: string | null;
  enabled: boolean;
  example: boolean;
}

export interface DocPage {
  path: string;
  title: string;
  text: string;
}

export interface DocsBundle {
  source: "installed" | "latest";
  version: string | null;
  tag: string | null;
  pages: DocPage[];
  fetchedAt: number | null;
  offline: boolean;
}

export interface DashboardState {
  enabled: boolean;
  phpReady: boolean;
  phpVersion: string | null;
  prepared: boolean;
  running: boolean;
  port: number | null;
  url: string | null;
  setupKey: string | null;
  setupDone: boolean;
  paired: boolean;
  needsRuntime: boolean;
  supported: boolean;
}

export const api = {
  appInfo: () => invoke<AppInfo>("app_info"),
  getPrefs: () => invoke<Prefs>("get_prefs"),
  setPrefs: (prefs: Partial<Prefs>) => invoke<Prefs>("set_prefs", { prefs }),

  listInstances: () => invoke<InstanceSummary[]>("list_instances"),
  suggestPath: (name: string) => invoke<string>("suggest_path", { name }),
  createInstance: (name: string, path: string) => invoke<InstanceSummary>("create_instance", { name, path }),
  importInstance: (name: string, path: string) => invoke<InstanceSummary>("import_instance", { name, path }),
  removeInstance: (id: string) => invoke<void>("remove_instance", { id }),
  renameInstance: (id: string, name: string) => invoke<InstanceSummary>("rename_instance", { id, name }),
  setInstanceOptions: (id: string, options: { autoRestart?: boolean; startWithLauncher?: boolean }) =>
    invoke<InstanceSummary>("set_instance_options", { id, options }),

  install: (id: string) => invoke<void>("install_instance", { id }),
  finishSetup: (id: string) => invoke<InstanceSummary>("finish_setup", { id }),
  repair: (id: string) => invoke<void>("repair_instance", { id }),

  tokenState: (id: string) => invoke<TokenState>("token_state", { id }),
  setToken: (id: string, token: string) => invoke<TokenState>("set_token", { id, token }),
  inspectToken: (token: string) => invoke<TokenState>("inspect_token", { token }),

  start: (id: string) => invoke<void>("start_bot", { id }),
  stop: (id: string) => invoke<void>("stop_bot", { id }),
  restart: (id: string) => invoke<void>("restart_bot", { id }),
  status: (id: string) => invoke<BotStatus>("bot_status", { id }),
  console: (id: string) => invoke<LogLine[]>("console_snapshot", { id }),
  clearConsole: (id: string) => invoke<void>("clear_console", { id }),
  open: (id: string, what: "folder" | "config" | "env" | "logs" | "extensions" | "data") =>
    invoke<void>("open_in_system", { id, what }),
  openExtension: (id: string, file: string) => invoke<void>("open_extension", { id, file }),

  readConfig: (id: string) => invoke<ConfigSnapshot>("read_config", { id }),
  saveConfig: (id: string, changes: Record<string, unknown>) =>
    invoke<SaveResult>("save_config", { id, changes }),
  removeOverride: (id: string, key: string) => invoke<ConfigSnapshot>("remove_override", { id, key }),
  listExtensions: (id: string) => invoke<ExtensionInfo[]>("list_extensions", { id }),
  setExtensionEnabled: (id: string, name: string, enabled: boolean) =>
    invoke<SaveResult>("set_extension_enabled", { id, name, enabled }),

  releaseCheck: (force: boolean) => invoke<ReleaseCheck>("release_check", { force }),
  updatePlan: (id: string) => invoke<UpdatePlan>("update_plan", { id }),
  updateBot: (id: string) => invoke<string>("update_bot", { id }),
  listBackups: (id: string) => invoke<BackupInfo[]>("list_backups", { id }),
  restoreBackup: (id: string, name: string) => invoke<void>("restore_backup", { id, name }),

  docs: (id: string | null, source: "installed" | "latest") =>
    invoke<DocsBundle>("docs_bundle", { id, source }),
  docAsset: (id: string | null, source: "installed" | "latest", path: string) =>
    invoke<string>("doc_asset", { id, source, path }),

  dashboardState: (id: string) => invoke<DashboardState>("dashboard_state", { id }),
  dashboardSetup: (id: string) => invoke<DashboardState>("dashboard_setup", { id }),
  dashboardStart: (id: string) => invoke<DashboardState>("dashboard_start", { id }),
  dashboardStop: (id: string) => invoke<DashboardState>("dashboard_stop", { id }),
  dashboardOpen: (id: string, page: "setup" | "home") => invoke<void>("dashboard_open", { id, page }),
  dashboardDisable: (id: string) => invoke<DashboardState>("dashboard_disable", { id }),

  openUrl: (url: string) => invoke<void>("open_url", { url }),
  quit: (stopBots: boolean) => invoke<void>("quit_app", { stopBots }),
};

export function onStatus(cb: (s: BotStatus) => void): Promise<UnlistenFn> {
  return listen<BotStatus>("bot-status", (e) => cb(e.payload));
}

export function onLog(cb: (p: { id: string; lines: LogLine[] }) => void): Promise<UnlistenFn> {
  return listen<{ id: string; lines: LogLine[] }>("bot-log", (e) => cb(e.payload));
}

export function onProgress(cb: (p: Progress) => void): Promise<UnlistenFn> {
  return listen<Progress>("progress", (e) => cb(e.payload));
}

export function onInstances(cb: (list: InstanceSummary[]) => void): Promise<UnlistenFn> {
  return listen<InstanceSummary[]>("instances", (e) => cb(e.payload));
}

export function onCloseRequested(cb: () => void): Promise<UnlistenFn> {
  return listen("close-requested", () => cb());
}

export function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return "Something went wrong. The launcher log has the details.";
}
