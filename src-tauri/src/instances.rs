use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::{Emitter, State};

use crate::app::App;
use crate::error::{Ctx, Res};
use crate::fsx;
use crate::paths::{self, Inst};
use crate::store::InstanceRecord;
use crate::token;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct InstanceMeta {
    pub tag: Option<String>,
    pub version: Option<String>,
    pub python: Option<String>,
    pub installed_at: u64,
    pub imported: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceSummary {
    pub id: String,
    pub name: String,
    pub path: String,
    pub version: Option<String>,
    pub state: String,
    pub health: Option<String>,
    pub auto_restart: bool,
    pub start_with_launcher: bool,
    pub bot_id: Option<String>,
    pub setup_done: bool,
}

pub fn read_meta(root: &Path) -> InstanceMeta {
    fsx::read_json(&Inst::new(root).meta_file()).unwrap_or_default()
}

pub fn write_meta(root: &Path, meta: &InstanceMeta) -> Res<()> {
    fsx::write_json(&Inst::new(root).meta_file(), meta)
}

pub fn pyproject_version(root: &Path) -> Option<String> {
    let text = fs::read_to_string(root.join("pyproject.toml")).ok()?;
    let doc: toml_edit::DocumentMut = text.parse().ok()?;
    doc.get("project")?.get("version")?.as_str().map(str::to_string)
}

pub fn is_installed(root: &Path) -> bool {
    let inst = Inst::new(root);
    inst.has_code() && inst.python().is_file() && read_meta(root).installed_at > 0
}

pub fn summarize(app: &App, rec: &InstanceRecord) -> InstanceSummary {
    let installed = is_installed(&rec.path);
    let meta = read_meta(&rec.path);
    let version = meta.version.clone().or_else(|| {
        if installed {
            pyproject_version(&rec.path)
        } else {
            None
        }
    });
    let (state, health) = app.bots.state_for(rec, installed);
    let bot_id = token::read(&Inst::new(&rec.path).env_file())
        .as_deref()
        .and_then(token::bot_id);
    InstanceSummary {
        id: rec.id.clone(),
        name: rec.name.clone(),
        path: rec.path.display().to_string(),
        version,
        state,
        health,
        auto_restart: rec.auto_restart,
        start_with_launcher: rec.start_with_launcher,
        bot_id,
        setup_done: rec.setup_done,
    }
}

pub fn all(app: &App) -> Vec<InstanceSummary> {
    app.store.instances().iter().map(|r| summarize(app, r)).collect()
}

pub fn broadcast(app: &App) {
    let _ = app.handle.emit("instances", all(app));
}

fn clean_name(name: &str) -> Res<String> {
    let n = name.trim();
    if n.is_empty() {
        return Err("Give the bot a name.".into());
    }
    if n.chars().count() > 40 {
        return Err("Keep the name under 40 characters.".into());
    }
    Ok(n.to_string())
}

fn normalize(path: &str) -> Res<PathBuf> {
    let raw = path.trim();
    if raw.is_empty() {
        return Err("Choose a folder.".into());
    }
    let expanded = if let Some(rest) = raw.strip_prefix("~/").or_else(|| raw.strip_prefix("~\\")) {
        dirs::home_dir()
            .ctx(|| "Your home folder could not be found.".into())?
            .join(rest)
    } else {
        PathBuf::from(raw)
    };
    if !expanded.is_absolute() {
        return Err("Use a full folder path, for example one chosen with Choose.".into());
    }
    Ok(expanded.components().collect())
}

fn overlaps(a: &Path, b: &Path) -> bool {
    a.starts_with(b) || b.starts_with(a)
}

fn check_free(app: &App, path: &Path) -> Res<()> {
    for other in app.store.instances() {
        if overlaps(&other.path, path) {
            return Err(format!(
                "\"{}\" already uses {}. Every bot needs a folder of its own.",
                other.name,
                other.path.display()
            ));
        }
    }
    Ok(())
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..12].to_string()
}

#[tauri::command]
pub fn list_instances(app: State<'_, Arc<App>>) -> Vec<InstanceSummary> {
    all(&app)
}

#[tauri::command]
pub fn suggest_path(app: State<'_, Arc<App>>, name: String) -> String {
    let root = paths::default_install_root();
    let base = paths::slug(&name);
    let taken: Vec<PathBuf> = app.store.instances().into_iter().map(|i| i.path).collect();
    for n in 1..100 {
        let candidate = if n == 1 {
            root.join(&base)
        } else {
            root.join(format!("{base}-{n}"))
        };
        let free = !taken.iter().any(|t| overlaps(t, &candidate))
            && (!candidate.exists() || fsx::is_empty_dir(&candidate));
        if free {
            return candidate.display().to_string();
        }
    }
    root.join(format!("{base}-{}", new_id())).display().to_string()
}

#[tauri::command]
pub fn create_instance(app: State<'_, Arc<App>>, name: String, path: String) -> Res<InstanceSummary> {
    let name = clean_name(&name)?;
    let path = normalize(&path)?;
    check_free(&app, &path)?;
    if path.exists() {
        if !path.is_dir() {
            return Err(format!("{} is a file, not a folder.", path.display()));
        }
        if !fsx::is_empty_dir(&path) {
            if Inst::new(&path).has_code() {
                return Err(
                    "This folder already has ZDBF in it. Choose Use a bot I already installed instead."
                        .into(),
                );
            }
            return Err("This folder is not empty. Choose an empty folder or a new one.".into());
        }
    }
    fs::create_dir_all(&path).ctx(|| format!("Could not create {}", path.display()))?;
    let rec = InstanceRecord {
        id: new_id(),
        name,
        path,
        auto_restart: true,
        start_with_launcher: false,
        setup_done: false,
        created_at: fsx::now_ms(),
    };
    app.store.update(|f| {
        f.instances.push(rec.clone());
        Ok(())
    })?;
    let summary = summarize(&app, &rec);
    broadcast(&app);
    Ok(summary)
}

#[tauri::command]
pub fn import_instance(app: State<'_, Arc<App>>, name: String, path: String) -> Res<InstanceSummary> {
    let name = clean_name(&name)?;
    let path = normalize(&path)?;
    let inst = Inst::new(&path);
    if !inst.has_code() {
        return Err(format!(
            "{} does not contain ZDBF V2. Choose the folder that has pyproject.toml and the zdbf folder.",
            path.display()
        ));
    }
    let text = fs::read_to_string(inst.pyproject()).unwrap_or_default();
    if !text.contains("name = \"zdbf\"") {
        return Err("This folder has a pyproject.toml, but not the one of ZDBF V2.".into());
    }
    check_free(&app, &path)?;
    if let Some(t) = token::read(&inst.env_file()) {
        ensure_token_unique(&app, None, &t)?;
    }
    let mut meta = read_meta(&path);
    meta.imported = true;
    meta.version = pyproject_version(&path);
    meta.tag = meta.version.as_ref().map(|v| format!("v{v}"));
    write_meta(&path, &meta)?;
    let has_token = token::read(&inst.env_file()).is_some();
    let rec = InstanceRecord {
        id: new_id(),
        name,
        path,
        auto_restart: true,
        start_with_launcher: false,
        setup_done: has_token,
        created_at: fsx::now_ms(),
    };
    app.store.update(|f| {
        f.instances.push(rec.clone());
        Ok(())
    })?;
    let summary = summarize(&app, &rec);
    broadcast(&app);
    Ok(summary)
}

#[tauri::command]
pub async fn remove_instance(app: State<'_, Arc<App>>, id: String) -> Res<()> {
    app.bots.stop_and_wait(&id).await;
    app.store.update(|f| {
        f.instances.retain(|i| i.id != id);
        if f.prefs.last_instance.as_deref() == Some(id.as_str()) {
            f.prefs.last_instance = None;
        }
        Ok(())
    })?;
    broadcast(&app);
    Ok(())
}

#[tauri::command]
pub fn rename_instance(app: State<'_, Arc<App>>, id: String, name: String) -> Res<InstanceSummary> {
    let name = clean_name(&name)?;
    let rec = app.store.update(|f| {
        let r = f
            .instances
            .iter_mut()
            .find(|i| i.id == id)
            .ctx(|| "This bot is gone.".into())?;
        r.name = name;
        Ok(r.clone())
    })?;
    broadcast(&app);
    Ok(summarize(&app, &rec))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceOptions {
    auto_restart: Option<bool>,
    start_with_launcher: Option<bool>,
}

#[tauri::command]
pub fn set_instance_options(
    app: State<'_, Arc<App>>,
    id: String,
    options: InstanceOptions,
) -> Res<InstanceSummary> {
    let rec = app.store.update(|f| {
        let r = f
            .instances
            .iter_mut()
            .find(|i| i.id == id)
            .ctx(|| "This bot is gone.".into())?;
        if let Some(v) = options.auto_restart {
            r.auto_restart = v;
        }
        if let Some(v) = options.start_with_launcher {
            r.start_with_launcher = v;
        }
        Ok(r.clone())
    })?;
    broadcast(&app);
    Ok(summarize(&app, &rec))
}

#[tauri::command]
pub fn finish_setup(app: State<'_, Arc<App>>, id: String) -> Res<InstanceSummary> {
    let rec = app.store.update(|f| {
        let r = f
            .instances
            .iter_mut()
            .find(|i| i.id == id)
            .ctx(|| "This bot is gone.".into())?;
        r.setup_done = true;
        Ok(r.clone())
    })?;
    broadcast(&app);
    Ok(summarize(&app, &rec))
}

pub fn ensure_token_unique(app: &App, own_id: Option<&str>, token: &str) -> Res<()> {
    for other in app.store.instances() {
        if Some(other.id.as_str()) == own_id {
            continue;
        }
        if token::read(&Inst::new(&other.path).env_file()).as_deref() == Some(token) {
            return Err(format!(
                "\"{}\" already uses this token. Two bots cannot share one token: Discord would disconnect one of them. Create a second application in the Developer Portal for this bot.",
                other.name
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn token_state(app: State<'_, Arc<App>>, id: String) -> Res<token::TokenState> {
    let rec = app.store.instance(&id)?;
    Ok(token::state_of(token::read(&Inst::new(&rec.path).env_file())))
}

#[tauri::command]
pub fn inspect_token(token: String) -> Res<token::TokenState> {
    let t = token::validate(&token)?;
    Ok(token::state_of(Some(t)))
}

#[tauri::command]
pub fn set_token(app: State<'_, Arc<App>>, id: String, token: String) -> Res<token::TokenState> {
    let rec = app.store.instance(&id)?;
    let t = token::validate(&token)?;
    ensure_token_unique(&app, Some(&id), &t)?;
    let inst = Inst::new(&rec.path);
    token::write(&inst.env_file(), &rec.path.join(".env.example"), &t)?;
    app.bots.remember_secret(&id, &t);
    broadcast(&app);
    Ok(token::state_of(Some(t)))
}
