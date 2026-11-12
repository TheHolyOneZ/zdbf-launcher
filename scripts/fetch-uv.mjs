import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const UV_VERSION = "0.13.8";
const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const TAR =
  process.platform === "win32" ? join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe") : "tar";
const outDir = join(root, "src-tauri", "binaries");

const ASSETS = {
  "x86_64-unknown-linux-gnu": "uv-x86_64-unknown-linux-gnu.tar.gz",
  "aarch64-unknown-linux-gnu": "uv-aarch64-unknown-linux-gnu.tar.gz",
  "x86_64-pc-windows-msvc": "uv-x86_64-pc-windows-msvc.zip",
  "aarch64-pc-windows-msvc": "uv-aarch64-pc-windows-msvc.zip",
  "x86_64-apple-darwin": "uv-x86_64-apple-darwin.tar.gz",
  "aarch64-apple-darwin": "uv-aarch64-apple-darwin.tar.gz",
};

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const line = out.split("\n").find((l) => l.startsWith("host:"));
  return line.slice(5).trim();
}

function findFile(dir, name) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      const hit = findFile(p, name);
      if (hit) return hit;
    } else if (entry === name) {
      return p;
    }
  }
  return null;
}

async function download(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": "zdbf-launcher-build" } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function fetchTriple(triple) {
  const asset = ASSETS[triple];
  if (!asset) throw new Error(`No uv build is known for ${triple}`);
  const exe = triple.includes("windows") ? ".exe" : "";
  const target = join(outDir, `zdbf-uv-${triple}${exe}`);
  const stamp = `${target}.version`;
  if (existsSync(target) && existsSync(stamp) && readFileSync(stamp, "utf8") === `${UV_VERSION} ${asset}`) return target;

  const base = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}`;
  const [archive, sumText] = await Promise.all([download(`${base}/${asset}`), download(`${base}/${asset}.sha256`)]);
  const expected = sumText.toString("utf8").trim().split(/\s+/)[0].toLowerCase();
  const actual = createHash("sha256").update(archive).digest("hex");
  if (expected !== actual) throw new Error(`Checksum mismatch for ${asset}: expected ${expected}, got ${actual}`);

  const work = mkdtempSync(join(tmpdir(), "zdbf-uv-"));
  try {
    const file = join(work, asset);
    writeFileSync(file, archive);
    if (asset.endsWith(".zip")) {
      if (process.platform === "win32") execFileSync(TAR, ["-xf", file, "-C", work]);
      else execFileSync("unzip", ["-q", "-o", file, "-d", work]);
    } else {
      execFileSync(TAR, ["-xzf", file, "-C", work]);
    }
    const bin = findFile(work, `uv${exe}`);
    if (!bin) throw new Error(`uv${exe} was not found in ${asset}`);
    mkdirSync(outDir, { recursive: true });
    copyFileSync(bin, target);
    if (!exe) chmodSync(target, 0o755);
    writeFileSync(stamp, `${UV_VERSION} ${asset}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  console.log(`uv ${UV_VERSION} for ${triple} is ready`);
  return target;
}

const wanted = process.argv[2] || process.env.TAURI_ENV_TARGET_TRIPLE || hostTriple();
if (wanted === "universal-apple-darwin") {
  const a = await fetchTriple("aarch64-apple-darwin");
  const b = await fetchTriple("x86_64-apple-darwin");
  const out = join(outDir, "zdbf-uv-universal-apple-darwin");
  execFileSync("lipo", ["-create", "-output", out, a, b]);
  console.log("uv universal binary is ready");
} else {
  await fetchTriple(wanted);
}
