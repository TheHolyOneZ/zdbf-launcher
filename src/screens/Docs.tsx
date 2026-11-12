import GithubSlugger from "github-slugger";
import { ArrowLeft, ExternalLink, Search } from "lucide-react";
import MiniSearch from "minisearch";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SegThumb } from "../components/fx";
import { Markdown } from "../components/Markdown";
import { Button, Callout, IconButton, Spinner } from "../components/ui";
import { api, type DocPage, type DocsBundle, errorText } from "../lib/api";
import { dateTime } from "../lib/format";
import { useCurrent, useStore } from "../state/store";

const GITHUB = "https://github.com/TheHolyOneZ/ZDBF-V2/blob";

interface Section {
  id: string;
  path: string;
  title: string;
  heading: string;
  slug: string;
  text: string;
}

function plain(md: string): string {
  return md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/[`*]/g, "")
    .trim();
}

export function sections(page: DocPage): Section[] {
  const slugger = new GithubSlugger();
  const out: Section[] = [];
  let heading = page.title;
  let slug = "";
  let buf: string[] = [];
  let fence = false;
  const flush = () => {
    const text = plain(buf.join(" ")).replace(/\s+/g, " ");
    if (text || slug)
      out.push({ id: `${page.path}#${slug}`, path: page.path, title: page.title, heading, slug, text });
    buf = [];
  };
  for (const line of page.text.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const m = fence ? null : /^(#{1,6})\s+(.*)$/.exec(line);
    if (m?.[2]) {
      flush();
      heading = plain(m[2].replace(/\s+#+\s*$/, ""));
      slug = slugger.slug(heading);
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
}

export function resolvePath(from: string, href: string): string {
  const raw = href.startsWith("/") ? href.slice(1) : dirOf(from) + href;
  const parts: string[] = [];
  for (const p of raw.split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return parts.join("/");
}

function group(path: string): string {
  if (path === "README.md" || path === "docs/README.md") return "Start here";
  if (path.startsWith("docs/guide/")) return "User guide";
  if (path.startsWith("docs/dev/")) return "Developer guide";
  if (path === "CHANGELOG.md") return "Changes";
  return "More";
}

function snippet(text: string, terms: string[]): string {
  const lower = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    at = lower.indexOf(t.toLowerCase());
    if (at >= 0) break;
  }
  const start = Math.max(0, at - 60);
  const s = text.slice(start, start + 180);
  return (start > 0 ? "…" : "") + s + (start + 180 < text.length ? "…" : "");
}

export function DocsScreen() {
  const current = useCurrent();
  const release = useStore((s) => s.release);
  const docTarget = useStore((s) => s.docTarget);
  const toast = useStore((s) => s.toast);
  const [source, setSource] = useState<"installed" | "latest">("installed");
  const [bundle, setBundle] = useState<DocsBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loc, setLoc] = useState<{ path: string; hash: string }>({ path: "README.md", hash: "" });
  const [history, setHistory] = useState<Array<{ path: string; hash: string }>>([]);
  const [query, setQuery] = useState("");
  const article = useRef<HTMLDivElement>(null);
  const images = useRef(new Map<string, string | null>());

  const installedVersion = current?.version ?? null;
  const latestVersion = release?.latest?.version ?? null;
  const showLatestToggle = !!current && !!latestVersion && latestVersion !== installedVersion;

  useEffect(() => {
    let alive = true;
    setBundle(null);
    setError(null);
    images.current.clear();
    api
      .docs(current?.id ?? null, current ? source : "latest")
      .then((b) => {
        if (alive) setBundle(b);
      })
      .catch((e) => {
        if (alive) setError(errorText(e));
      });
    return () => {
      alive = false;
    };
  }, [current, source]);

  useEffect(() => {
    if (!docTarget) return;
    const [path, hash] = docTarget.split("#");
    setLoc({ path: path || "README.md", hash: hash ?? "" });
    useStore.setState({ docTarget: null });
  }, [docTarget]);

  const index = useMemo(() => {
    const ms = new MiniSearch<Section>({
      fields: ["heading", "text", "title"],
      storeFields: ["path", "title", "heading", "slug", "text"],
      searchOptions: { boost: { heading: 3, title: 2 }, prefix: true, fuzzy: 0.15 },
    });
    if (bundle) ms.addAll(bundle.pages.flatMap(sections));
    return ms;
  }, [bundle]);

  const results = useMemo(() => {
    const q = query.trim();
    if (q.length < 2) return [];
    return index.search(q).slice(0, 30);
  }, [index, query]);

  const page = bundle?.pages.find((p) => p.path === loc.path) ?? bundle?.pages[0] ?? null;

  useEffect(() => {
    const el = article.current;
    if (!el || !page) return;
    requestAnimationFrame(() => {
      if (loc.hash) {
        const target = document.getElementById(decodeURIComponent(loc.hash));
        if (target) {
          target.scrollIntoView({ block: "start" });
          return;
        }
      }
      el.scrollTop = 0;
    });
  }, [page, loc.hash]);

  const go = useCallback(
    (path: string, hash = "") => {
      setHistory((h) => [...h.slice(-30), loc]);
      setLoc({ path, hash });
    },
    [loc],
  );

  const onLink = useCallback(
    (href: string) => {
      if (!page || !bundle) return;
      const [rawPath, hash = ""] = href.split("#");
      const target = rawPath ? resolvePath(page.path, rawPath) : page.path;
      if (bundle.pages.some((p) => p.path === target)) {
        go(target, hash);
        return;
      }
      const ref = bundle.tag ?? "main";
      void api.openUrl(`${GITHUB}/${ref}/${target}${hash ? `#${hash}` : ""}`);
    },
    [page, bundle, go],
  );

  const resolveImage = useCallback(
    async (src: string) => {
      if (!page) return null;
      const rel = resolvePath(page.path, src.split("?")[0] ?? src);
      const cached = images.current.get(rel);
      if (cached !== undefined) return cached;
      try {
        const url = await api.docAsset(current?.id ?? null, bundle?.source ?? "latest", rel);
        images.current.set(rel, url);
        return url;
      } catch {
        images.current.set(rel, null);
        return null;
      }
    },
    [page, current, bundle],
  );

  const groups = useMemo(() => {
    const m = new Map<string, DocPage[]>();
    for (const p of bundle?.pages ?? []) {
      const g = group(p.path);
      m.set(g, [...(m.get(g) ?? []), p]);
    }
    return [...m.entries()];
  }, [bundle]);

  return (
    <div className="docs">
      <aside className="docs-side">
        <label className="console-search docs-search">
          <Search size={15} aria-hidden />
          <span className="visually-hidden">Search the documentation</span>
          <input
            type="search"
            value={query}
            placeholder="Search the docs"
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        </label>
        {showLatestToggle ? (
          <div className="seg docs-source" role="radiogroup" aria-label="Documentation version">
            <SegThumb />
            <button
              type="button"
              role="radio"
              aria-checked={source === "installed"}
              className="seg-item"
              onClick={() => setSource("installed")}
            >
              {installedVersion} installed
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={source === "latest"}
              className="seg-item"
              onClick={() => setSource("latest")}
            >
              {latestVersion} newest
            </button>
          </div>
        ) : null}
        {query.trim().length >= 2 ? (
          <div className="docs-results" aria-live="polite">
            {results.length === 0 ? (
              <p className="faint docs-none">Nothing found for “{query.trim()}”.</p>
            ) : (
              <ul>
                {results.map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => {
                        go(r.path as string, r.slug as string);
                      }}
                    >
                      <span className="docs-r-title">
                        {r.title as string}
                        {r.heading !== r.title ? (
                          <span className="faint"> › {r.heading as string}</span>
                        ) : null}
                      </span>
                      <span className="docs-r-snip">{snippet(r.text as string, r.terms)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : (
          <nav className="docs-nav" aria-label="Pages">
            {groups.map(([g, pages]) => (
              <div key={g} className="docs-group">
                <p className="docs-group-title">{g}</p>
                <ul>
                  {pages.map((p) => (
                    <li key={p.path}>
                      <button
                        type="button"
                        className={page?.path === p.path ? "is-active" : undefined}
                        aria-current={page?.path === p.path ? "page" : undefined}
                        onClick={() => go(p.path)}
                      >
                        {p.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </nav>
        )}
      </aside>

      <div className="docs-main" ref={article}>
        {error ? (
          <Callout tone="bad" title="The documentation could not be loaded.">
            <p className="selectable">{error}</p>
          </Callout>
        ) : !bundle || !page ? (
          <p className="progress-label">
            <Spinner /> Loading the documentation
          </p>
        ) : (
          <>
            <div className="docs-bar">
              <IconButton
                label="Back"
                disabled={history.length === 0}
                onClick={() => {
                  const prev = history[history.length - 1];
                  if (!prev) return;
                  setHistory((h) => h.slice(0, -1));
                  setLoc(prev);
                }}
              >
                <ArrowLeft size={17} />
              </IconButton>
              <span className="faint docs-where mono">{page.path}</span>
              <span className="faint docs-ver">
                {bundle.source === "installed"
                  ? `ZDBF ${bundle.version ?? ""}, installed`
                  : `ZDBF ${bundle.version ?? ""}, from GitHub`}
                {bundle.offline && bundle.fetchedAt
                  ? `, offline copy from ${dateTime(bundle.fetchedAt)}`
                  : ""}
              </span>
              <Button
                size="sm"
                variant="quiet"
                icon={<ExternalLink size={14} />}
                onClick={() =>
                  api
                    .openUrl(`${GITHUB}/${bundle.tag ?? "main"}/${page.path}`)
                    .catch((e) => toast("bad", errorText(e)))
                }
              >
                GitHub
              </Button>
            </div>
            <article className="docs-article">
              <Markdown
                key={`${bundle.source}:${page.path}`}
                text={page.text}
                onInternalLink={onLink}
                resolveImage={resolveImage}
              />
            </article>
          </>
        )}
      </div>
    </div>
  );
}
