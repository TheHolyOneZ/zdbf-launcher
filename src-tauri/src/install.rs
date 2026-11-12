use std::collections::BTreeMap;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{Emitter, State};

use crate::app::App;
use crate::bots::{self, BotState};
use crate::error::{Ctx, Res};
use crate::fsx::{self, now_ms};
use crate::instances;
use crate::paths::Inst;
use crate::python;
use crate::release::{self, ReleaseInfo};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub tag: String,
    pub version: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub id: String,
    pub task: String,
    pub step: String,
    pub label: String,
    pub detail: Option<String>,
    pub fraction: Option<f64>,
    pub done: bool,
    pub error: Option<String>,
}

pub struct Reporter {
    pub app: Arc<App>,
    pub id: String,
    pub task: &'static str,
}

impl Reporter {
    pub fn step(&self, step: &str, label: &str) {
        self.send(step, label, None, None, false, None);
    }

    pub fn detail(&self, step: &str, label: &str, detail: &str, fraction: Option<f64>) {
        self.send(step, label, Some(detail.to_string()), fraction, false, None);
    }

    pub fn done(&self, label: &str) {
        self.send("done", label, None, Some(1.0), true, None);
    }

    pub fn fail(&self, error: &str) {
        self.send("failed", "Stopped", None, None, true, Some(error.to_string()));
    }

    fn send(
        &self,
        step: &str,
        label: &str,
        detail: Option<String>,
        fraction: Option<f64>,
        done: bool,
        error: Option<String>,
    ) {
        let p = Progress {
            id: self.id.clone(),
            task: self.task.into(),
            step: step.into(),
            label: label.into(),
            detail,
            fraction,
            done,
            error,
        };
        let _ = self.app.handle.emit("progress", &p);
    }
}

pub fn protected(rel: &str) -> bool {
    let first = rel.split('/').next().unwrap_or("");
    if rel == ".env" || (rel.starts_with(".env.") && rel != ".env.example") || rel == "config.toml" {
        return true;
    }
    if matches!(
        first,
        "data" | "logs" | "migrations" | ".venv" | ".zdbf-launcher" | "botlogs"
    ) {
        return true;
    }
    if first == "extensions" {
        return rel != "extensions/example.py" && rel != "extensions/README.md";
    }
    rel.ends_with(".pyc") || rel.contains("/__pycache__/") || first == "__pycache__"
}

fn downloads_dir(app: &App) -> PathBuf {
    app.data_dir.join("cache").join("downloads")
}

pub async fn download_release(app: &Arc<App>, info: &ReleaseInfo, rep: &Reporter) -> Res<PathBuf> {
    let dir = downloads_dir(app);
    fs::create_dir_all(&dir).ctx(|| format!("Could not create {}", dir.display()))?;
    let target = dir.join(format!("zdbf-{}.tar.gz", info.tag));
    if target.is_file() && verify_tarball(&target) {
        return Ok(target);
    }
    let label = format!("Downloading ZDBF {}", info.version);
    rep.step("download", &label);
    let url = if info.tarball.is_empty() {
        format!(
            "{}/repos/{}/tarball/{}",
            release::api_base(),
            release::REPO,
            info.tag
        )
    } else {
        info.tarball.clone()
    };
    let mut resp = app
        .http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("The download from GitHub failed: {e}. Check your internet connection."))?;
    if !resp.status().is_success() {
        return Err(format!(
            "GitHub refused the download (status {}).",
            resp.status().as_u16()
        ));
    }
    let total = resp.content_length();
    let part = target.with_extension("part");
    let mut file = fs::File::create(&part).ctx(|| format!("Could not write {}", part.display()))?;
    let mut got: u64 = 0;
    let mut last = 0u64;
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("The download was interrupted: {e}"))?
    {
        file.write_all(&chunk)
            .ctx(|| format!("Could not write {}", part.display()))?;
        got += chunk.len() as u64;
        if got - last > 256 * 1024 {
            last = got;
            rep.detail(
                "download",
                &label,
                &format!("{:.1} MB", got as f64 / 1_048_576.0),
                total.map(|t| got as f64 / t as f64),
            );
        }
    }
    file.sync_all().ok();
    drop(file);
    if !verify_tarball(&part) {
        let _ = fs::remove_file(&part);
        return Err("The downloaded archive is damaged. Try again.".into());
    }
    fsx::replace(&part, &target)?;
    prune_downloads(&dir, 3);
    Ok(target)
}

fn prune_downloads(dir: &Path, keep: usize) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .filter(|(_, p)| p.extension().map(|x| x == "gz").unwrap_or(false))
        .collect();
    files.sort_by_key(|f| std::cmp::Reverse(f.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = fs::remove_file(p);
    }
}

fn verify_tarball(path: &Path) -> bool {
    let Ok(f) = fs::File::open(path) else { return false };
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(f));
    let Ok(entries) = ar.entries() else { return false };
    let mut n = 0;
    for e in entries {
        let Ok(mut e) = e else { return false };
        if std::io::copy(&mut e, &mut std::io::sink()).is_err() {
            return false;
        }
        n += 1;
    }
    n > 10
}

fn safe_rel(path: &Path) -> Option<String> {
    let mut parts = Vec::new();
    for (i, c) in path.components().enumerate() {
        match c {
            Component::Normal(s) if i > 0 => parts.push(s.to_str()?.to_string()),
            Component::Normal(_) => {}
            _ => return None,
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

pub fn extract(tarball: &Path, dest: &Path, tag: &str, version: &str, skip_protected: bool) -> Res<Manifest> {
    let f = fs::File::open(tarball).ctx(|| format!("Could not open {}", tarball.display()))?;
    let mut ar = tar::Archive::new(flate2::read::GzDecoder::new(f));
    let mut manifest = Manifest {
        tag: tag.into(),
        version: version.into(),
        files: BTreeMap::new(),
    };
    for entry in ar.entries().ctx(|| "The archive could not be read".into())? {
        let mut entry = entry.ctx(|| "The archive could not be read".into())?;
        let kind = entry.header().entry_type();
        if !(kind.is_file() || kind.is_dir()) {
            continue;
        }
        let path = entry
            .path()
            .ctx(|| "The archive has a bad file name".into())?
            .into_owned();
        let Some(rel) = safe_rel(&path) else { continue };
        if skip_protected && protected(&rel) {
            continue;
        }
        let out = fsx::from_slash(dest, &rel);
        if kind.is_dir() {
            fs::create_dir_all(&out).ctx(|| format!("Could not create {}", out.display()))?;
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).ctx(|| format!("Could not create {}", parent.display()))?;
        }
        let mut buf = Vec::new();
        entry
            .read_to_end(&mut buf)
            .ctx(|| format!("Could not read {rel} from the archive"))?;
        let hash = hex::encode(Sha256::digest(&buf));
        fs::write(&out, &buf).ctx(|| format!("Could not write {}", out.display()))?;
        #[cfg(unix)]
        if let Ok(mode) = entry.header().mode() {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&out, fs::Permissions::from_mode(mode & 0o755 | 0o644));
        }
        manifest.files.insert(rel, hash);
    }
    if manifest.files.is_empty() {
        return Err("The archive is empty.".into());
    }
    Ok(manifest)
}

pub fn hash_file(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    Some(hash_bytes(&bytes))
}

pub fn hash_bytes(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub async fn ensure_python(
    app: &Arc<App>,
    rep: &Reporter,
    inst: &Inst,
    recreate: bool,
    imported: bool,
) -> Res<String> {
    rep.step("python", &format!("Getting Python {}", python::PYTHON_VERSION));
    let uv = python::uv_path();
    if !uv.is_file() {
        return Err(format!(
            "The launcher's copy of uv is missing ({}). Reinstall the launcher.",
            uv.display()
        ));
    }
    let mut cmd = python::uv_command(app);
    cmd.args(["python", "install", python::PYTHON_VERSION]);
    let r2 = Reporter {
        app: app.clone(),
        id: rep.id.clone(),
        task: rep.task,
    };
    let label = format!("Getting Python {}", python::PYTHON_VERSION);
    python::run_streaming(cmd, move |l| r2.detail("python", &label, l, None)).await?;

    let existing = if inst.python().is_file() && !recreate {
        python::python_version(&inst.python())
            .await
            .filter(|v| python::supported(v))
    } else {
        None
    };
    if existing.is_none() {
        rep.step("venv", "Creating the Python environment");
        let venv = inst.venv();
        if venv.exists() {
            if imported {
                let aside = inst.root.join(format!(".venv.old-{}", now_ms()));
                fs::rename(&venv, &aside).ctx(|| format!("Could not move the old {}", venv.display()))?;
            } else {
                fs::remove_dir_all(&venv).ctx(|| format!("Could not remove the old {}", venv.display()))?;
            }
        }
        let mut cmd = python::uv_command(app);
        cmd.arg("venv")
            .arg("--seed")
            .arg("--python")
            .arg(python::PYTHON_VERSION)
            .arg(&venv);
        let r2 = Reporter {
            app: app.clone(),
            id: rep.id.clone(),
            task: rep.task,
        };
        python::run_streaming(cmd, move |l| {
            r2.detail("venv", "Creating the Python environment", l, None)
        })
        .await?;
    }
    install_requirements(app, rep, inst).await?;
    python::python_version(&inst.python())
        .await
        .ctx(|| "The new Python environment does not start.".into())
}

pub async fn install_requirements(app: &Arc<App>, rep: &Reporter, inst: &Inst) -> Res<()> {
    let label = "Installing the packages ZDBF needs";
    rep.step("packages", label);
    let mut cmd = python::uv_command(app);
    cmd.args(["pip", "install", "--python"])
        .arg(inst.python())
        .arg("-e")
        .arg(&inst.root);
    let r2 = Reporter {
        app: app.clone(),
        id: rep.id.clone(),
        task: rep.task,
    };
    python::run_streaming(cmd, move |l| r2.detail("packages", label, l, None)).await?;
    Ok(())
}

pub async fn verify(rep: &Reporter, inst: &Inst) -> Res<()> {
    rep.step("verify", "Checking the installation");
    let mut cmd = tokio::process::Command::new(inst.python());
    cmd.args(["-m", "zdbf", "--version"])
        .current_dir(&inst.root)
        .env("PYTHONUTF8", "1")
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    python::hide_window(&mut cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("Python could not be started: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string();
        return Err(format!("ZDBF does not start: {last}"));
    }
    Ok(())
}

async fn run_install(app: &Arc<App>, id: &str, repair: bool) -> Res<()> {
    let rec = app.store.instance(id)?;
    let inst = Inst::new(&rec.path);
    let rep = Reporter {
        app: app.clone(),
        id: id.to_string(),
        task: if repair { "repair" } else { "install" },
    };
    let mut meta = instances::read_meta(&rec.path);
    fs::create_dir_all(inst.meta()).ctx(|| format!("Could not create {}", inst.meta().display()))?;

    if !inst.has_code() {
        rep.step("release", "Looking up the newest ZDBF release");
        let check = release::check(app, true).await;
        let info = match check.latest {
            Some(i) => i,
            None => {
                return Err(check
                    .error
                    .unwrap_or_else(|| "No ZDBF release was found on GitHub.".into()));
            }
        };
        let tarball = download_release(app, &info, &rep).await?;
        rep.step("extract", &format!("Unpacking ZDBF {}", info.version));
        let (tb, root, tag, version) = (
            tarball.clone(),
            rec.path.clone(),
            info.tag.clone(),
            info.version.clone(),
        );
        let manifest = tokio::task::spawn_blocking(move || extract(&tb, &root, &tag, &version, true))
            .await
            .map_err(|e| e.to_string())??;
        fsx::write_json(&inst.manifest(), &manifest)?;
        meta.tag = Some(info.tag.clone());
        meta.version = Some(info.version.clone());
        meta.imported = false;
        instances::write_meta(&rec.path, &meta)?;
    }

    let py = ensure_python(app, &rep, &inst, repair, meta.imported).await?;
    verify(&rep, &inst).await?;
    meta.python = Some(py);
    meta.installed_at = now_ms();
    if meta.version.is_none() {
        meta.version = instances::pyproject_version(&rec.path);
    }
    instances::write_meta(&rec.path, &meta)?;
    Ok(())
}

async fn guarded(app: Arc<App>, id: String, repair: bool) -> Res<()> {
    if app.bots.is_live(&id) {
        return Err("Stop the bot first.".into());
    }
    {
        let mut running = app.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if !running.insert(id.clone()) {
            return Err("The launcher is already working on this bot.".into());
        }
    }
    app.bots.set_busy(&app, &id, Some(BotState::Installing));
    instances::broadcast(&app);
    let result = run_install(&app, &id, repair).await;
    app.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    app.bots.set_busy(&app, &id, None);
    let rep = Reporter {
        app: app.clone(),
        id: id.clone(),
        task: if repair { "repair" } else { "install" },
    };
    match &result {
        Ok(()) => rep.done(if repair { "Repaired" } else { "Installed" }),
        Err(e) => {
            rep.fail(e);
            app.bots.launcher_line(&app, &id, "ERROR", e);
        }
    }
    instances::broadcast(&app);
    bots::emit_status(&app, &id);
    result
}

#[tauri::command]
pub async fn install_instance(app: State<'_, Arc<App>>, id: String) -> Res<()> {
    guarded(app.inner().clone(), id, false).await
}

#[tauri::command]
pub async fn repair_instance(app: State<'_, Arc<App>>, id: String) -> Res<()> {
    guarded(app.inner().clone(), id, true).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protected_paths() {
        for p in [
            ".env",
            "config.toml",
            "data/zdbf.db",
            "logs/zdbf.log",
            "migrations/x.py",
            "extensions/mine.py",
            ".venv/bin/python",
            ".env.local",
        ] {
            assert!(protected(p), "{p} should be protected");
        }
        for p in [
            ".env.example",
            "extensions/example.py",
            "extensions/README.md",
            "zdbf/__main__.py",
            "pyproject.toml",
            "dashboard/index.php",
        ] {
            assert!(!protected(p), "{p} should be shipped");
        }
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert_eq!(safe_rel(Path::new("top/zdbf/a.py")).as_deref(), Some("zdbf/a.py"));
        assert_eq!(safe_rel(Path::new("top/../etc/passwd")), None);
        assert_eq!(safe_rel(Path::new("top")), None);
    }
}
