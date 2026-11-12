import { ArrowUpRight, Bot, Globe, LayoutGrid, Puzzle, Rocket } from "lucide-react";
import type { ReactNode } from "react";
import { RollText } from "../components/fx";
import { Core } from "../components/Mark";
import { api } from "../lib/api";
import { useStore } from "../state/store";

const SITE = "https://zsync.eu/";

interface Place {
  title: string;
  text: string;
  url: string;
  icon: ReactNode;
  soon?: boolean;
}

const PLACES: Place[] = [
  {
    title: "ZDBF",
    text: "The Discord bot this launcher runs: features, guides and news.",
    url: "https://zsync.eu/zdbf/",
    icon: <Bot size={20} />,
  },
  {
    title: "Extensions",
    text: "Add commands and features to your bot from the ZSync Marketplace.",
    url: "https://zsync.eu/extension/",
    icon: <Puzzle size={20} />,
  },
  {
    title: "ZDBF Launcher",
    text: "The launcher's own page, with downloads and help.",
    url: "https://zsync.eu/zdbf-launcher/",
    icon: <Rocket size={20} />,
    soon: true,
  },
  {
    title: "More from ZSync",
    text: "Other projects by TheHolyOneZ.",
    url: SITE,
    icon: <LayoutGrid size={20} />,
  },
];

const REPOS: Place[] = [
  {
    title: "ZDBF V2 on GitHub",
    text: "Source code, releases and issues for the bot.",
    url: "https://github.com/TheHolyOneZ/ZDBF-V2",
    icon: <GitHubMark />,
  },
  {
    title: "ZDBF Launcher on GitHub",
    text: "Source code, releases and issues for this launcher.",
    url: "https://github.com/TheHolyOneZ/zdbf-launcher",
    icon: <GitHubMark />,
  },
];

function GitHubMark() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.69 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.84 1.19 3.1 0 4.42-2.69 5.39-5.26 5.68.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z" />
    </svg>
  );
}

function Card({ place }: { place: Place }) {
  return (
    <button type="button" className="about-card panel spot" onClick={() => api.openUrl(place.url)}>
      <span className="about-card-icon">{place.icon}</span>
      <span className="about-card-body">
        <span className="about-card-title">
          {place.title}
          {place.soon ? <span className="tag">Coming soon</span> : null}
        </span>
        <span className="about-card-text">{place.text}</span>
        <span className="about-card-url mono">{place.url.replace(/^https:\/\//, "").replace(/\/$/, "")}</span>
      </span>
      <ArrowUpRight className="about-card-arrow" size={18} aria-hidden />
    </button>
  );
}

export function AboutScreen() {
  const app = useStore((s) => s.app);
  const os = app?.os === "macos" ? "macOS" : app?.os === "windows" ? "Windows" : "Linux";
  return (
    <div className="about">
      <header className="about-hero">
        <div className="about-core" aria-hidden>
          <Core tone="ok" size={220} ringMode="uptime" ring={1} listen />
        </div>
        <div className="about-intro">
          <RollText as="h1" className="about-title" text="ZDBF Launcher" stretch />
          <p className="page-lead" data-reveal>
            Install, run, configure and update your own ZDBF V2 Discord bot without Python or a command line.
            Made by TheHolyOneZ as part of ZSync.
          </p>
          <dl className="about-facts" data-reveal>
            <div>
              <dt>Version</dt>
              <dd className="mono">{app?.version ?? "unknown"}</dd>
            </div>
            <div>
              <dt>System</dt>
              <dd>
                {os} <span className="faint mono">{app?.arch}</span>
              </dd>
            </div>
            <div>
              <dt>License</dt>
              <dd>Apache 2.0</dd>
            </div>
          </dl>
        </div>
      </header>

      <section className="about-group" aria-labelledby="about-web">
        <h2 id="about-web" className="section-title">
          <Globe size={18} aria-hidden /> On the web
        </h2>
        <div className="about-grid">
          {PLACES.map((p) => (
            <Card key={p.url} place={p} />
          ))}
        </div>
      </section>

      <section className="about-group" aria-labelledby="about-code">
        <h2 id="about-code" className="section-title">
          <GitHubMark /> Source code
        </h2>
        <div className="about-grid about-grid-2">
          {REPOS.map((p) => (
            <Card key={p.url} place={p} />
          ))}
        </div>
      </section>

      <p className="hint about-foot" data-reveal>
        The launcher bundles uv by Astral and downloads Python, the bot's packages and PHP from their
        publishers when a feature needs them. Their licenses are listed in THIRD-PARTY-NOTICES.md in the
        launcher's repository. The names ZDBF, ZSync, Zoryx and TheHolyOneZ are not licensed as trademarks.
      </p>
    </div>
  );
}
