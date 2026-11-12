import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const isWin = process.platform === "win32";
const bins = join(root, "src-tauri", "binaries");
const TRIPLES = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win32-x64": "x86_64-pc-windows-msvc",
  "win32-arm64": "aarch64-pc-windows-msvc",
  "darwin-x64": "x86_64-apple-darwin",
  "darwin-arm64": "aarch64-apple-darwin",
};
const triple = TRIPLES[`${process.platform}-${process.arch}`];
const uv = join(bins, `zdbf-uv-${triple}${isWin ? ".exe" : ""}`);
if (!triple || !existsSync(uv)) throw new Error(`Run node scripts/fetch-uv.mjs ${triple ?? ""} first`);

const work = mkdtempSync(join(tmpdir(), "zdbf-smoke-"));
const TAR =
  process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const env = {
  ...process.env,
  UV_PYTHON_INSTALL_DIR: join(work, "python"),
  UV_CACHE_DIR: join(work, "cache"),
  UV_PYTHON_PREFERENCE: "only-managed",
  UV_NO_CONFIG: "1",
  UV_NO_PROGRESS: "1",
  PYTHONUTF8: "1",
  PYTHONIOENCODING: "utf-8",
};
delete env.VIRTUAL_ENV;
delete env.PYTHONHOME;
delete env.PYTHONPATH;

function run(cmd, args, opts = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  return execFileSync(cmd, args, { stdio: "inherit", env, ...opts });
}

const apiHeaders = {
  "User-Agent": "zdbf-launcher-ci",
  Accept: "application/vnd.github+json",
  ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}),
};

async function latestTag() {
  const res = await fetch("https://api.github.com/repos/TheHolyOneZ/ZDBF-V2/releases?per_page=30", {
    headers: apiHeaders,
  });
  const list = await res.json();
  if (!res.ok || !Array.isArray(list)) {
    throw new Error(`GitHub answered ${res.status}: ${list?.message ?? "no release list"}`);
  }
  const tags = list
    .filter((r) => !r.draft && !r.prerelease && /^v2\.\d+\.\d+$/.test(r.tag_name))
    .map((r) => r.tag_name)
    .sort((a, b) => {
      const pa = a.slice(1).split(".").map(Number);
      const pb = b.slice(1).split(".").map(Number);
      return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
    });
  if (!tags.length) throw new Error("No v2.x.y release found");
  return tags[0];
}

try {
  const tag = await latestTag();
  console.log(`Testing ZDBF ${tag} on ${process.platform}/${process.arch}`);
  const res = await fetch(`https://api.github.com/repos/TheHolyOneZ/ZDBF-V2/tarball/${tag}`, {
    headers: apiHeaders,
  });
  if (!res.ok) throw new Error(`Downloading ${tag} failed: GitHub answered ${res.status}`);
  const tarball = join(work, "zdbf.tar.gz");
  writeFileSync(tarball, Buffer.from(await res.arrayBuffer()));
  const bot = join(work, "bot");
  mkdirSync(bot);
  run(TAR, ["-xzf", tarball, "-C", bot, "--strip-components=1"]);
  run(uv, ["python", "install", "3.13"]);
  run(uv, ["venv", "--seed", "--python", "3.13", join(bot, ".venv")]);
  const py = isWin ? join(bot, ".venv", "Scripts", "python.exe") : join(bot, ".venv", "bin", "python");
  if (!existsSync(py)) throw new Error(`${py} was not created`);
  run(uv, ["pip", "install", "--python", py, "-e", bot]);
  run(py, ["-m", "zdbf", "--version"], { cwd: bot });
  const check = spawnSync(py, ["-m", "zdbf", "--check"], { cwd: bot, env, encoding: "utf8" });
  console.log(check.stdout, check.stderr);
  if (check.status !== 1 || !check.stdout.includes("MISSING")) {
    throw new Error(`--check should exit 1 with the token missing, got ${check.status}`);
  }
  run(py, ["-m", "pip", "--version"], { cwd: bot });
  console.log("Smoke test passed: uv, managed Python, venv with pip, ZDBF install, --check.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
