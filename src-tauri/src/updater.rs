use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app::App;
use crate::bots::{self, BotState};
use crate::error::{Ctx, Res};
use crate::fsx::{self, now_ms};
use crate::install::{self, Manifest, Reporter};
use crate::instances::{self, InstanceMeta};
use crate::paths::Inst;
use crate::python;
use crate::release::{self, ReleaseInfo};

const KEEP_BACKUPS: usize = 3;
const READY_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePlan {
    current: Option<String>,
    latest: Option<ReleaseInfo>,
    available: bool,
    changed_by_you: Vec<String>,
    removed_upstream: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupMeta {
    version: Option<String>,
    tag: Option<String>,
    created_at: u64,
    files: Vec<String>,
    has_manifest: bool,
    has_freeze: bool,
    reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    name: String,
    version: Option<String>,
    created_at: u64,
    size_bytes: u64,
}

fn read_manifest(inst: &Inst) -> Option<Manifest> {
    fsx::read_json(&inst.manifest())
}

pub fn changed_files(inst: &Inst, manifest: &Manifest) -> Vec<String> {
    manifest
        .files
        .iter()
        .filter(|(rel, hash)| {
            let p = fsx::from_slash(&inst.root, rel);
            p.is_file() && install::hash_file(&p).as_deref() != Some(hash.as_str())
        })
        .map(|(rel, _)| rel.clone())
        .collect()
}

fn shipped_on_disk(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    walk(root, root, &mut out);
    out.sort();
    out
}

fn walk(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let Some(rel) = fsx::rel_slash(base, &p) else {
            continue;
        };
        if install::protected(&rel) || rel.starts_with(".venv") || rel.starts_with(".git/") || rel == ".git" {
            continue;
        }
        if rel.ends_with(".egg-info") || rel.contains(".egg-info/") || rel.starts_with(".venv.old-") {
            continue;
        }
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(base, &p, out),
            Ok(t) if t.is_file() => out.push(rel),
            _ => {}
        }
    }
}

async fn freeze(app: &App, inst: &Inst) -> Option<String> {
    let mut cmd = python::uv_command(app);
    cmd.args(["pip", "freeze", "--python"]).arg(inst.python());
    let out = cmd.output().await.ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

fn copy_into(src_root: &Path, dst_root: &Path, rel: &str) -> Res<()> {
    let src = fsx::from_slash(src_root, rel);
    let dst = fsx::from_slash(dst_root, rel);
    if let Some(p) = dst.parent() {
        fs::create_dir_all(p).ctx(|| format!("Could not create {}", p.display()))?;
    }
    fs::copy(&src, &dst).ctx(|| format!("Could not copy {rel}"))?;
    Ok(())
}

async fn make_backup(app: &App, inst: &Inst, meta: &InstanceMeta, reason: &str) -> Res<PathBuf> {
    let name = format!(
        "{}-{}",
        now_ms(),
        meta.version.clone().unwrap_or_else(|| "unknown".into())
    );
    let dir = inst.backups().join(&name);
    let files_dir = dir.join("files");
    fs::create_dir_all(&files_dir).ctx(|| format!("Could not create {}", files_dir.display()))?;
    let manifest = read_manifest(inst);
    let mut files: Vec<String> = match &manifest {
        Some(m) => m
            .files
            .keys()
            .filter(|r| !install::protected(r))
            .cloned()
            .collect(),
        None => shipped_on_disk(&inst.root),
    };
    for extra in [".env", "config.toml"] {
        if inst.root.join(extra).is_file() {
            files.push(extra.into());
        }
    }
    let root = inst.root.clone();
    let fd = files_dir.clone();
    let list = files.clone();
    tokio::task::spawn_blocking(move || -> Res<()> {
        for rel in &list {
            if fsx::from_slash(&root, rel).is_file() {
                copy_into(&root, &fd, rel)?;
            }
        }
        for folder in ["data", "extensions"] {
            let src = root.join(folder);
            if src.is_dir() {
                fsx::copy_dir(&src, &fd.join(folder), &|p| {
                    p.file_name().map(|n| n == "__pycache__").unwrap_or(false)
                })?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    if let Some(m) = &manifest {
        fsx::write_json(&dir.join("manifest.json"), m)?;
    }
    fsx::write_json(&dir.join("instance.json"), meta)?;
    let frozen = freeze(app, inst).await;
    if let Some(f) = &frozen {
        fsx::atomic_write(&dir.join("requirements.lock"), f.as_bytes())?;
    }
    let info = BackupMeta {
        version: meta.version.clone(),
        tag: meta.tag.clone(),
        created_at: now_ms(),
        files,
        has_manifest: manifest.is_some(),
        has_freeze: frozen.is_some(),
        reason: reason.into(),
    };
    fsx::write_json(&dir.join("backup.json"), &info)?;
    prune_backups(inst);
    Ok(dir)
}

fn prune_backups(inst: &Inst) {
    let Ok(rd) = fs::read_dir(inst.backups()) else {
        return;
    };
    let mut dirs: Vec<PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.join("backup.json").is_file())
        .collect();
    dirs.sort();
    if dirs.len() > KEEP_BACKUPS {
        for d in &dirs[..dirs.len() - KEEP_BACKUPS] {
            let _ = fs::remove_dir_all(d);
        }
    }
}

fn remove_empty_parents(root: &Path, file: &Path) {
    let mut cur = file.parent();
    while let Some(dir) = cur {
        if dir == root || !dir.starts_with(root) {
            break;
        }
        if fs::remove_dir(dir).is_err() {
            break;
        }
        cur = dir.parent();
    }
}

struct Applied {
    kept: Vec<String>,
}

fn apply_files(root: &Path, staging: &Path, old: Option<&Manifest>, new: &Manifest) -> Res<Applied> {
    let mut kept = Vec::new();
    for rel in new.files.keys() {
        if install::protected(rel) {
            continue;
        }
        let src = fsx::from_slash(staging, rel);
        let dst = fsx::from_slash(root, rel);
        if let Some(p) = dst.parent() {
            fs::create_dir_all(p).ctx(|| format!("Could not create {}", p.display()))?;
        }
        let tmp = dst.with_file_name(format!(
            ".{}.zdbf-new",
            dst.file_name().and_then(|n| n.to_str()).unwrap_or("file")
        ));
        fs::copy(&src, &tmp).ctx(|| format!("Could not write {rel}"))?;
        fsx::replace(&tmp, &dst)?;
    }
    if let Some(old) = old {
        for (rel, hash) in &old.files {
            if new.files.contains_key(rel) || install::protected(rel) {
                continue;
            }
            let p = fsx::from_slash(root, rel);
            if !p.is_file() {
                continue;
            }
            if install::hash_file(&p).as_deref() == Some(hash.as_str()) {
                let _ = fs::remove_file(&p);
                remove_empty_parents(root, &p);
            } else {
                kept.push(rel.clone());
            }
        }
    }
    Ok(Applied { kept })
}

async fn check_config(app: &App, inst: &Inst) -> Res<()> {
    if !inst.config().is_file() {
        return Ok(());
    }
    let mut cmd = tokio::process::Command::new(inst.python());
    cmd.args(["-m", "zdbf", "--check"])
        .current_dir(&inst.root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    python::bot_env(app, inst, &mut cmd);
    python::hide_window(&mut cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("The new version could not be checked: {e}"))?;
    match out.status.code() {
        Some(0) | Some(1) => Ok(()),
        _ => {
            let err = String::from_utf8_lossy(&out.stderr);
            let last: Vec<&str> = err
                .lines()
                .filter(|l| !l.trim().is_empty())
                .rev()
                .take(4)
                .collect();
            Err(format!(
                "The new version does not accept your settings: {}",
                last.into_iter().rev().collect::<Vec<_>>().join(" ")
            ))
        }
    }
}

async fn wait_for_start(app: &Arc<App>, id: &str) -> Res<()> {
    let deadline = std::time::Instant::now() + READY_TIMEOUT;
    loop {
        tokio::time::sleep(Duration::from_millis(500)).await;
        let rec = app.store.instance(id)?;
        let s = app.bots.snapshot(id, &rec.path, true);
        match s.state {
            BotState::Running => return Ok(()),
            BotState::Crashed | BotState::Waiting | BotState::Stopped => {
                let exit = s.last_exit.clone();
                let reason = exit.as_ref().map(|e| e.reason.clone()).unwrap_or_default();
                if matches!(reason.as_str(), "token_invalid" | "token_missing" | "intents") {
                    return Ok(());
                }
                if s.state == BotState::Waiting {
                    app.bots.stop_and_wait(id).await;
                }
                let msg = exit
                    .map(|e| e.message)
                    .filter(|m| !m.is_empty())
                    .unwrap_or_else(|| "no details".into());
                return Err(format!("The bot does not start with the new version: {msg}"));
            }
            _ => {}
        }
        if std::time::Instant::now() > deadline {
            return Err("The bot did not finish starting within two minutes.".into());
        }
    }
}

async fn restore_from(app: &Arc<App>, inst: &Inst, backup: &Path, rep: &Reporter) -> Res<()> {
    rep.step("rollback", "Putting the previous version back");
    let info: BackupMeta =
        fsx::read_json(&backup.join("backup.json")).ctx(|| "The backup is incomplete.".into())?;
    let files_dir = backup.join("files");
    let current = read_manifest(inst);
    let old_manifest: Option<Manifest> = fsx::read_json(&backup.join("manifest.json"));
    let root = inst.root.clone();
    let fd = files_dir.clone();
    let list = info.files.clone();
    tokio::task::spawn_blocking(move || -> Res<()> {
        if let Some(cur) = &current {
            for (rel, hash) in &cur.files {
                if install::protected(rel) || list.contains(rel) {
                    continue;
                }
                let p = fsx::from_slash(&root, rel);
                if p.is_file() && install::hash_file(&p).as_deref() == Some(hash.as_str()) {
                    let _ = fs::remove_file(&p);
                    remove_empty_parents(&root, &p);
                }
            }
        }
        for rel in &list {
            if fsx::from_slash(&fd, rel).is_file() {
                copy_into(&fd, &root, rel)?;
            }
        }
        for folder in ["data", "extensions"] {
            let src = fd.join(folder);
            if src.is_dir() {
                let dst = root.join(folder);
                let aside = root.join(format!(".{folder}.replaced-{}", now_ms()));
                if dst.exists() {
                    fs::rename(&dst, &aside).ctx(|| format!("Could not move {}", dst.display()))?;
                }
                fsx::copy_dir(&src, &dst, &|_| false)?;
                let _ = fs::remove_dir_all(&aside);
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    match old_manifest {
        Some(m) => fsx::write_json(&inst.manifest(), &m)?,
        None => {
            let _ = fs::remove_file(inst.manifest());
        }
    }
    let mut meta: InstanceMeta = fsx::read_json(&backup.join("instance.json")).unwrap_or_default();
    if meta.installed_at == 0 {
        meta.installed_at = now_ms();
    }
    instances::write_meta(&inst.root, &meta)?;
    rep.step("rollback-packages", "Restoring the Python packages");
    let lock = backup.join("requirements.lock");
    if lock.is_file() {
        let mut cmd = python::uv_command(app);
        cmd.args(["pip", "sync", "--python"])
            .arg(inst.python())
            .arg(&lock);
        if python::run_streaming(cmd, |_| {}).await.is_err() {
            install::install_requirements(app, rep, inst).await?;
        }
    } else {
        install::install_requirements(app, rep, inst).await?;
    }
    Ok(())
}

fn sentence(s: &str) -> String {
    let t = s.trim();
    if t.ends_with(['.', '!', '?']) {
        t.to_string()
    } else {
        format!("{t}.")
    }
}

async fn run_update(app: &Arc<App>, id: &str, rep: &Reporter) -> Res<String> {
    let rec = app.store.instance(id)?;
    let inst = Inst::new(&rec.path);
    let meta = instances::read_meta(&rec.path);
    let current = meta.version.clone().unwrap_or_default();

    rep.step("release", "Looking up the newest release");
    let check = release::check(app, false).await;
    let latest = check.latest.ctx(|| {
        check
            .error
            .clone()
            .unwrap_or_else(|| "No release was found on GitHub.".into())
    })?;
    if !release::newer(&latest.version, &current) {
        return Err(format!("ZDBF {current} is already the newest version."));
    }

    let tarball = install::download_release(app, &latest, rep).await?;
    rep.step("extract", &format!("Unpacking ZDBF {}", latest.version));
    let staging = inst.meta().join("staging");
    let _ = fs::remove_dir_all(&staging);
    let (tb, st, tag, ver) = (
        tarball.clone(),
        staging.clone(),
        latest.tag.clone(),
        latest.version.clone(),
    );
    let new_manifest = tokio::task::spawn_blocking(move || install::extract(&tb, &st, &tag, &ver, false))
        .await
        .map_err(|e| e.to_string())??;

    let was_running = app.bots.is_live(id);
    if was_running {
        rep.step("stop", "Stopping the bot");
        app.bots.stop_and_wait(id).await;
    }
    app.bots.set_busy(app, id, Some(BotState::Updating));

    rep.step("backup", "Backing up the bot");
    let backup = make_backup(app, &inst, &meta, &format!("before update to {}", latest.version)).await?;

    let attempt: Res<Vec<String>> = async {
        rep.step("files", &format!("Installing ZDBF {}", latest.version));
        let old = read_manifest(&inst);
        let (root, st, nm) = (rec.path.clone(), staging.clone(), new_manifest.clone());
        let applied = tokio::task::spawn_blocking(move || apply_files(&root, &st, old.as_ref(), &nm))
            .await
            .map_err(|e| e.to_string())??;
        let shipped = Manifest {
            tag: new_manifest.tag.clone(),
            version: new_manifest.version.clone(),
            files: new_manifest
                .files
                .iter()
                .filter(|(k, _)| !install::protected(k))
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect::<BTreeMap<_, _>>(),
        };
        fsx::write_json(&inst.manifest(), &shipped)?;
        let mut m = meta.clone();
        m.tag = Some(latest.tag.clone());
        m.version = Some(latest.version.clone());
        m.imported = false;
        m.installed_at = now_ms();
        instances::write_meta(&rec.path, &m)?;
        install::install_requirements(app, rep, &inst).await?;
        install::verify(rep, &inst).await?;
        rep.step("check", "Checking your settings with the new version");
        check_config(app, &inst).await?;
        Ok(applied.kept)
    }
    .await;

    let _ = fs::remove_dir_all(&staging);

    let kept = match attempt {
        Ok(k) => k,
        Err(e) => {
            app.bots
                .launcher_line(app, id, "ERROR", &format!("The update failed: {e}"));
            restore_from(app, &inst, &backup, rep).await?;
            app.bots.set_busy(app, id, None);
            if was_running {
                let _ = bots::start(app, id).await;
            }
            return Err(format!(
                "{} The previous version {current} was put back.",
                sentence(&e)
            ));
        }
    };

    app.bots.set_busy(app, id, None);
    if was_running {
        rep.step("start", "Starting the bot");
        bots::start(app, id).await?;
        if let Err(e) = wait_for_start(app, id).await {
            app.bots
                .launcher_line(app, id, "ERROR", &format!("The update failed: {e}"));
            app.bots.stop_and_wait(id).await;
            app.bots.set_busy(app, id, Some(BotState::Updating));
            restore_from(app, &inst, &backup, rep).await?;
            app.bots.set_busy(app, id, None);
            let _ = bots::start(app, id).await;
            return Err(format!(
                "{} The previous version {current} was put back.",
                sentence(&e)
            ));
        }
    }
    let _ = crate::dashboard::refresh_web(app, id);
    let mut note = format!("Updated to ZDBF {}.", latest.version);
    if !kept.is_empty() {
        note.push_str(&format!(
            " These files were removed in the new version but you changed them, so they were kept: {}.",
            kept.join(", ")
        ));
    }
    app.bots.launcher_line(app, id, "INFO", &note);
    Ok(note)
}

#[tauri::command]
pub async fn update_plan(app: State<'_, Arc<App>>, id: String) -> Res<UpdatePlan> {
    let app = app.inner().clone();
    let rec = app.store.instance(&id)?;
    let inst = Inst::new(&rec.path);
    let meta = instances::read_meta(&rec.path);
    let check = release::check(&app, false).await;
    let current = meta
        .version
        .clone()
        .or_else(|| instances::pyproject_version(&rec.path));
    let available = match (&check.latest, &current) {
        (Some(l), Some(c)) => release::newer(&l.version, c),
        (Some(_), None) => true,
        _ => false,
    };
    let changed_by_you = match read_manifest(&inst) {
        Some(m) => {
            let inst2 = Inst::new(&rec.path);
            tokio::task::spawn_blocking(move || changed_files(&inst2, &m))
                .await
                .unwrap_or_default()
        }
        None => Vec::new(),
    };
    Ok(UpdatePlan {
        current,
        latest: check.latest,
        available,
        changed_by_you,
        removed_upstream: 0,
    })
}

#[tauri::command]
pub async fn update_bot(app: State<'_, Arc<App>>, id: String) -> Res<String> {
    let app = app.inner().clone();
    {
        let mut running = app.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if !running.insert(id.clone()) {
            return Err("The launcher is already working on this bot.".into());
        }
    }
    let rep = Reporter {
        app: app.clone(),
        id: id.clone(),
        task: "update",
    };
    let result = run_update(&app, &id, &rep).await;
    app.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    app.bots.set_busy(&app, &id, None);
    match &result {
        Ok(msg) => rep.done(msg),
        Err(e) => rep.fail(e),
    }
    instances::broadcast(&app);
    bots::emit_status(&app, &id);
    result
}

#[tauri::command]
pub fn list_backups(app: State<'_, Arc<App>>, id: String) -> Res<Vec<BackupInfo>> {
    let rec = app.store.instance(&id)?;
    let inst = Inst::new(&rec.path);
    let Ok(rd) = fs::read_dir(inst.backups()) else {
        return Ok(Vec::new());
    };
    let mut out: Vec<BackupInfo> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let meta: BackupMeta = fsx::read_json(&p.join("backup.json"))?;
            Some(BackupInfo {
                name: e.file_name().to_string_lossy().into_owned(),
                version: meta.version,
                created_at: meta.created_at,
                size_bytes: fsx::dir_size(&p),
            })
        })
        .collect();
    out.sort_by_key(|b| std::cmp::Reverse(b.created_at));
    Ok(out)
}

#[tauri::command]
pub async fn restore_backup(app: State<'_, Arc<App>>, id: String, name: String) -> Res<()> {
    let app = app.inner().clone();
    let rec = app.store.instance(&id)?;
    let inst = Inst::new(&rec.path);
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("Unknown backup.".into());
    }
    let dir = inst.backups().join(&name);
    if !dir.join("backup.json").is_file() {
        return Err("This backup no longer exists.".into());
    }
    if app.bots.is_live(&id) {
        return Err("Stop the bot first.".into());
    }
    {
        let mut running = app.tasks.lock().unwrap_or_else(|e| e.into_inner());
        if !running.insert(id.clone()) {
            return Err("The launcher is already working on this bot.".into());
        }
    }
    let rep = Reporter {
        app: app.clone(),
        id: id.clone(),
        task: "update",
    };
    app.bots.set_busy(&app, &id, Some(BotState::Updating));
    let meta = instances::read_meta(&rec.path);
    let result = async {
        make_backup(&app, &inst, &meta, "before restoring a backup").await?;
        restore_from(&app, &inst, &dir, &rep).await
    }
    .await;
    app.tasks.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    app.bots.set_busy(&app, &id, None);
    let _ = crate::dashboard::refresh_web(&app, &id);
    match &result {
        Ok(()) => rep.done("The backup is restored."),
        Err(e) => rep.fail(e),
    }
    instances::broadcast(&app);
    bots::emit_status(&app, &id);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(files: &[(&str, &str)]) -> Manifest {
        Manifest {
            tag: "v".into(),
            version: "v".into(),
            files: files
                .iter()
                .map(|(a, b)| (a.to_string(), install::hash_bytes(b.as_bytes())))
                .collect(),
        }
    }

    #[test]
    fn applies_new_files_and_cleans_removed_ones() {
        let base = std::env::temp_dir().join(format!("zdbf-upd-{}", std::process::id()));
        let root = base.join("root");
        let staging = base.join("staging");
        let _ = fs::remove_dir_all(&base);
        for (dir, rel, text) in [
            (&root, "zdbf/a.py", "old a"),
            (&root, "zdbf/gone.py", "gone"),
            (&root, "zdbf/edited.py", "edited by user"),
            (&root, "config.toml", "mine"),
            (&root, "extensions/mine.py", "mine"),
            (&staging, "zdbf/a.py", "new a"),
            (&staging, "zdbf/b.py", "new b"),
            (&staging, "config.toml", "theirs"),
            (&staging, "extensions/example.py", "example"),
        ] {
            let p = fsx::from_slash(dir, rel);
            fs::create_dir_all(p.parent().unwrap()).unwrap();
            fs::write(p, text).unwrap();
        }
        let old = manifest(&[
            ("zdbf/a.py", "old a"),
            ("zdbf/gone.py", "gone"),
            ("zdbf/edited.py", "original"),
        ]);
        let new = manifest(&[
            ("zdbf/a.py", "new a"),
            ("zdbf/b.py", "new b"),
            ("config.toml", "theirs"),
            ("extensions/example.py", "example"),
        ]);
        let applied = apply_files(&root, &staging, Some(&old), &new).unwrap();
        assert_eq!(fs::read_to_string(root.join("zdbf/a.py")).unwrap(), "new a");
        assert_eq!(fs::read_to_string(root.join("zdbf/b.py")).unwrap(), "new b");
        assert!(!root.join("zdbf/gone.py").exists());
        assert!(root.join("zdbf/edited.py").exists());
        assert_eq!(applied.kept, vec!["zdbf/edited.py".to_string()]);
        assert_eq!(fs::read_to_string(root.join("config.toml")).unwrap(), "mine");
        assert_eq!(
            fs::read_to_string(root.join("extensions/mine.py")).unwrap(),
            "mine"
        );
        assert_eq!(
            fs::read_to_string(root.join("extensions/example.py")).unwrap(),
            "example"
        );
        fs::remove_dir_all(&base).ok();
    }
}
