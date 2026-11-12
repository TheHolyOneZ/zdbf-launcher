export type Kind = "bool" | "int" | "float" | "text" | "choice" | "ids" | "tags" | "multi" | "timezone";

export interface Option {
  value: string;
  label: string;
  hint?: string;
}

export interface FieldDef {
  key: string;
  label: string;
  help: string;
  kind: Kind;
  options?: Option[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  restart?: boolean;
  advanced?: boolean;
  placeholder?: string;
  short?: boolean;
}

export interface SectionDef {
  id: string;
  title: string;
  lead: string;
  fields: FieldDef[];
}

export interface ModuleDef {
  key: string;
  label: string;
  help: string;
  locked?: boolean;
}

export const MODULES: ModuleDef[] = [
  { key: "core", label: "Basics", help: "/help, /about, /ping and /stats." },
  {
    key: "admin",
    label: "Owner tools",
    help: "/fw and /ext, and checking the settings. Always on.",
    locked: true,
  },
  {
    key: "settings",
    label: "Server settings",
    help: "/settings: prefix and command permissions per server.",
  },
  {
    key: "diagnostics",
    label: "Health checks",
    help: "/diag, the health check every few minutes and its alerts.",
  },
  {
    key: "eventhooks",
    label: "Event hooks",
    help: "/eventhooks for extensions that react to framework events.",
  },
  {
    key: "automations",
    label: "Automations",
    help: "/hooks: welcome messages, role panels, tickets, levels, word filter and more.",
  },
  {
    key: "plugins",
    label: "Extension checks",
    help: "/plugins: dependency and conflict checks for extensions.",
  },
  { key: "scheduler", label: "Scheduler", help: "/schedule: messages and tasks on a schedule." },
  { key: "backup", label: "Server backups", help: "/backup: snapshot and restore your server's setup." },
  { key: "shards", label: "Shard monitor", help: "/shard: connection health for large bots." },
  {
    key: "cluster",
    label: "Clusters",
    help: "/cluster: several bot processes working together. For very large bots.",
  },
  {
    key: "marketplace",
    label: "ZSync Marketplace",
    help: "/marketplace: browse and install community extensions.",
  },
  {
    key: "dashboard",
    label: "Web dashboard",
    help: "/dashboard and the link to the web dashboard. Set it up on this computer under Web dashboard.",
  },
];

const CAPS: Option[] = [
  { value: "view", label: "View", hint: "Status, statistics and lists" },
  { value: "logs", label: "Logs", hint: "Live log" },
  { value: "chat.read", label: "Read chat", hint: "Channels the bot can see" },
  { value: "chat.send", label: "Send chat", hint: "The bot's own messages and reactions" },
  { value: "chat.moderate", label: "Moderate chat", hint: "Delete other members' messages, pin" },
  { value: "commands.run", label: "Run commands", hint: "As an ordinary member" },
  { value: "commands.owner", label: "Run owner commands", hint: "As the bot owner" },
  { value: "extensions", label: "Extensions", hint: "Load, unload, reload" },
  { value: "marketplace", label: "Marketplace", hint: "Install extensions and Python packages" },
  { value: "files.read", label: "Read files", hint: "Inside the allowed folders" },
  { value: "files.write", label: "Write files", hint: "Create, change, rename, delete" },
  { value: "config", label: "Configuration", hint: "Change config.toml and overrides" },
  { value: "automations", label: "Automations" },
  { value: "scheduler", label: "Scheduler" },
  { value: "settings", label: "Server settings", hint: "Prefixes and permissions" },
  { value: "backups", label: "Backups", hint: "Create, list, compare" },
  { value: "backups.restore", label: "Restore backups" },
  { value: "presence", label: "Presence", hint: "The bot's status" },
  { value: "database", label: "Database", hint: "Read-only browser" },
  { value: "guilds.leave", label: "Leave servers" },
  { value: "system", label: "System", hint: "Shut the bot down" },
];

export const SECTIONS: SectionDef[] = [
  {
    id: "commands",
    title: "Commands",
    lead: "How members call the bot in Discord.",
    fields: [
      {
        key: "bot.prefix",
        label: "Command prefix",
        help: "Commands also work with this in front, for example !help. Servers can set their own with /settings prefix.",
        kind: "text",
        placeholder: "!",
        short: true,
      },
      {
        key: "bot.mention_prefix",
        label: "Allow @Bot as a prefix",
        help: "Members can write @YourBot help.",
        kind: "bool",
      },
      {
        key: "bot.delete_invoking_message",
        label: "Delete the command message",
        help: "Removes a member's !command message after the bot answers.",
        kind: "bool",
      },
      {
        key: "cooldowns.default_rate",
        label: "Uses before a cooldown",
        help: "Commands without their own cooldown can be used this many times per period by one member. Bot owners are exempt.",
        kind: "int",
        min: 1,
      },
      {
        key: "cooldowns.default_per",
        label: "Cooldown period",
        help: "The period for the line above.",
        kind: "float",
        min: 0.5,
        step: 0.5,
        unit: "seconds",
      },
      {
        key: "bot.sync_on_start",
        label: "Update slash commands on start",
        help: "Sends the list of slash commands to Discord when it changed. Leave this on.",
        kind: "bool",
        advanced: true,
      },
      {
        key: "bot.dev_guild_ids",
        label: "Servers for owner commands",
        help: "Server IDs. Owner-only commands like /fw are then only listed there. Empty means everywhere; they stay owner-only either way.",
        kind: "ids",
        advanced: true,
      },
    ],
  },
  {
    id: "owners",
    title: "Owners and intents",
    lead: "Who controls the bot, and what Discord lets it see.",
    fields: [
      {
        key: "bot.owner_ids",
        label: "Extra owners",
        help: "Discord user IDs of people who may use owner commands. You, as the owner of the application, are detected on your own.",
        kind: "ids",
      },
      {
        key: "bot.privileged_intents",
        label: "Privileged intents",
        help: "Turn the same ones on in the Developer Portal under Bot, or Discord refuses the login.",
        kind: "multi",
        restart: true,
        options: [
          {
            value: "members",
            label: "Server members",
            hint: "Backups, welcome messages, levels, automations",
          },
          {
            value: "message_content",
            label: "Message content",
            hint: "Prefix commands and message triggers",
          },
          { value: "presences", label: "Presences", hint: "Online status of members. Rarely needed" },
        ],
      },
    ],
  },
  {
    id: "look",
    title: "Look in Discord",
    lead: "The bot's status line and the buttons on /help.",
    fields: [
      {
        key: "status.interval",
        label: "Change the status every",
        help: "The status texts themselves are in the file, under [[status.rotation]].",
        kind: "int",
        min: 10,
        max: 3600,
        unit: "seconds",
      },
      {
        key: "ui.decorative_emoji",
        label: "Emoji in card titles",
        help: "Status dots are always shown.",
        kind: "bool",
      },
      {
        key: "ui.help_banner",
        label: "Banner on /help",
        help: "An image address. Empty uses the bot's profile banner, if it has one.",
        kind: "text",
        placeholder: "https://",
      },
      {
        key: "ui.support_url",
        label: "Support server link",
        help: "Adds a Support server button to /help and /about.",
        kind: "text",
        placeholder: "https://discord.gg/...",
      },
      { key: "ui.invite_button", label: "Invite button on /help", help: "For public bots.", kind: "bool" },
      {
        key: "ui.invite_permissions",
        label: "Invite permissions",
        help: "The permissions number in the invite link. 8 is Administrator.",
        kind: "int",
        min: 0,
        advanced: true,
      },
    ],
  },
  {
    id: "backups",
    title: "Server backups",
    lead: "Limits and automatic backups for /backup.",
    fields: [
      {
        key: "backup.max_per_guild",
        label: "Backups per server",
        help: "Older ones are not deleted on their own; creating more is refused.",
        kind: "int",
        min: 1,
        max: 500,
      },
      {
        key: "backup.cooldown_seconds",
        label: "Wait between backups",
        help: "Per server.",
        kind: "int",
        min: 0,
        unit: "seconds",
      },
      {
        key: "backup.auto_interval_hours",
        label: "Automatic backup every",
        help: "0 turns automatic backups off.",
        kind: "int",
        min: 0,
        unit: "hours",
      },
      {
        key: "backup.retention_days",
        label: "Delete backups after",
        help: "0 keeps them forever. Pinned backups are always kept.",
        kind: "int",
        min: 0,
        unit: "days",
      },
    ],
  },
  {
    id: "scheduler",
    title: "Scheduler",
    lead: "Scheduled tasks created with /schedule.",
    fields: [
      {
        key: "scheduler.timezone",
        label: "Time zone",
        help: "Schedule times use this zone, for example Europe/Berlin.",
        kind: "timezone",
      },
      {
        key: "scheduler.max_tasks_per_guild",
        label: "Tasks per server",
        help: "",
        kind: "int",
        min: 1,
        max: 500,
      },
    ],
  },
  {
    id: "extensions",
    title: "Extensions",
    lead: "Loading of Python files in the extensions folder. Turn single extensions on and off under Extensions.",
    fields: [
      { key: "extensions.auto_load", label: "Load extensions on start", help: "", kind: "bool" },
      {
        key: "extensions.hot_reload",
        label: "Reload an extension when its file changes",
        help: "A broken change is rolled back and the old version keeps running.",
        kind: "bool",
      },
      {
        key: "extensions.hot_reload_interval",
        label: "Check for changes every",
        help: "",
        kind: "float",
        min: 1,
        max: 600,
        unit: "seconds",
      },
      {
        key: "marketplace.auto_install_packages",
        label: "Offer to install missing Python packages",
        help: "When a marketplace extension needs packages, the bot offers to install them.",
        kind: "bool",
      },
      {
        key: "marketplace.cache_minutes",
        label: "Keep the marketplace list for",
        help: "",
        kind: "int",
        min: 1,
        unit: "minutes",
        advanced: true,
      },
      {
        key: "extensions.directory",
        label: "Extensions folder",
        help: "Relative to the bot folder.",
        kind: "text",
        advanced: true,
        restart: true,
      },
    ],
  },
  {
    id: "health",
    title: "Health checks",
    lead: "When the bot counts as degraded or critical in /diag and on the Overview.",
    fields: [
      {
        key: "diagnostics.health_interval_minutes",
        label: "Check every",
        help: "",
        kind: "int",
        min: 1,
        max: 1440,
        unit: "minutes",
      },
      {
        key: "diagnostics.loop_lag_threshold_ms",
        label: "Slow when the bot lags more than",
        help: "",
        kind: "int",
        min: 10,
        unit: "ms",
      },
      {
        key: "diagnostics.error_rate_warn_percent",
        label: "Warn when this share of commands fails",
        help: "Twice this counts as critical.",
        kind: "float",
        min: 0,
        max: 100,
        unit: "%",
      },
      {
        key: "diagnostics.error_rate_min_commands",
        label: "Judge failures after",
        help: "Commands in the last hour before the error rate counts, so one failure on a quiet bot does not raise an alarm.",
        kind: "int",
        min: 1,
        unit: "commands",
      },
    ],
  },
  {
    id: "logs",
    title: "Logs and maintenance",
    lead: "Log files, database backups and cleanup.",
    fields: [
      {
        key: "logging.level",
        label: "Log detail",
        help: "Debug writes much more and helps when you look for a problem.",
        kind: "choice",
        restart: true,
        options: [
          { value: "DEBUG", label: "Debug" },
          { value: "INFO", label: "Info" },
          { value: "WARNING", label: "Warnings" },
          { value: "ERROR", label: "Errors" },
          { value: "CRITICAL", label: "Critical only" },
        ],
      },
      {
        key: "logging.retention_days",
        label: "Delete log files after",
        help: "",
        kind: "int",
        min: 0,
        unit: "days",
        restart: true,
      },
      {
        key: "logging.backup_count",
        label: "Old log files to keep",
        help: "Per log, when it rotates.",
        kind: "int",
        min: 0,
        max: 100,
        restart: true,
      },
      {
        key: "logging.max_bytes",
        label: "Start a new log file at",
        help: "",
        kind: "int",
        min: 1024,
        unit: "bytes",
        restart: true,
        advanced: true,
      },
      {
        key: "logging.directory",
        label: "Logs folder",
        help: "Relative to the bot folder.",
        kind: "text",
        restart: true,
        advanced: true,
      },
      {
        key: "maintenance.db_backup_keep",
        label: "Database backups to keep",
        help: "Rolling backups in data/db_backups.",
        kind: "int",
        min: 1,
        max: 100,
      },
      {
        key: "maintenance.db_backup_interval_hours",
        label: "Back up the database every",
        help: "",
        kind: "int",
        min: 1,
        max: 720,
        unit: "hours",
      },
      {
        key: "maintenance.clean_pycache",
        label: "Clean __pycache__ in extensions every hour",
        help: "",
        kind: "bool",
        advanced: true,
      },
    ],
  },
  {
    id: "dashboard",
    title: "Web dashboard rules",
    lead: "What the web dashboard may do. The bot enforces this; the website cannot change it.",
    fields: [
      {
        key: "dashboard.capabilities",
        label: "Allowed",
        help: "Everything else is switched off on the website.",
        kind: "multi",
        options: CAPS,
      },
      {
        key: "dashboard.approval",
        label: "Needs your approval in a Discord DM",
        help: "Only matters for allowed areas.",
        kind: "multi",
        options: CAPS,
      },
      {
        key: "dashboard.approval_timeout",
        label: "Deny an unanswered approval after",
        help: "",
        kind: "int",
        min: 30,
        max: 3600,
        unit: "seconds",
      },
      { key: "dashboard.locked", label: "View only", help: "Same as /dashboard lock.", kind: "bool" },
      {
        key: "dashboard.file_roots",
        label: "Folders the file manager may open",
        help: "Relative to the bot folder.",
        kind: "tags",
      },
      {
        key: "dashboard.max_file_kb",
        label: "Largest file to read or write",
        help: "",
        kind: "int",
        min: 1,
        max: 65536,
        unit: "KB",
        advanced: true,
      },
      {
        key: "dashboard.idle_interval",
        label: "Check-in while nobody watches",
        help: "",
        kind: "int",
        min: 15,
        max: 600,
        unit: "seconds",
        advanced: true,
      },
    ],
  },
  {
    id: "advanced",
    title: "Advanced",
    lead: "Only change these if you know you need to.",
    fields: [
      {
        key: "database.path",
        label: "Database file",
        help: "Relative to the bot folder.",
        kind: "text",
        restart: true,
      },
      {
        key: "shards.alert_threshold",
        label: "Shard failures before an alert",
        help: "",
        kind: "int",
        min: 1,
        max: 20,
      },
      {
        key: "cluster.mode",
        label: "Cluster role",
        help: "Exactly one process is the server.",
        kind: "choice",
        restart: true,
        options: [
          { value: "server", label: "Server" },
          { value: "client", label: "Client" },
        ],
      },
      { key: "cluster.host", label: "Cluster address", help: "", kind: "text", restart: true },
      {
        key: "cluster.port",
        label: "Cluster port",
        help: "",
        kind: "int",
        min: 1,
        max: 65535,
        restart: true,
      },
      { key: "cluster.name", label: "Name of this process", help: "", kind: "text", restart: true },
      { key: "marketplace.api_url", label: "Marketplace list address", help: "", kind: "text" },
      { key: "marketplace.download_url", label: "Marketplace download address", help: "", kind: "text" },
    ],
  },
];

export const KNOWN_KEYS = new Set<string>([
  ...SECTIONS.flatMap((s) => s.fields.map((f) => f.key)),
  ...MODULES.map((m) => `modules.${m.key}`),
  "extensions.blacklist",
  "status.rotation",
]);
