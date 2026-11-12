use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value as Json};
use tauri::State;

use crate::app::App;
use crate::config::{self, SaveResult};
use crate::error::Res;
use crate::paths::Inst;
use crate::python;

const LISTER: &str = r#"
import json, pathlib, sys
try:
    from zdbf.core.plugins import read_static_metadata
except Exception:
    read_static_metadata = None
root = pathlib.Path(sys.argv[1])
out = []
if root.is_dir():
    for p in sorted(root.iterdir()):
        if p.name.startswith(("_", ".")):
            continue
        if p.is_file() and p.suffix == ".py":
            target = p
        elif p.is_dir() and (p / "__init__.py").exists():
            target = p / "__init__.py"
        else:
            continue
        meta = {}
        if read_static_metadata:
            try:
                meta = read_static_metadata(target)
            except Exception:
                meta = {}
        out.append({"name": p.stem if p.is_file() else p.name, "file": p.name, "isPackage": p.is_dir(),
                    "version": meta.get("__version__"), "description": meta.get("__description__"),
                    "author": meta.get("__author__")})
print(json.dumps(out, default=str))
"#;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInfo {
    name: String,
    file: String,
    is_package: bool,
    version: Option<serde_json::Value>,
    description: Option<serde_json::Value>,
    author: Option<serde_json::Value>,
    #[serde(default)]
    enabled: bool,
    #[serde(default)]
    example: bool,
}

fn text(v: &Option<serde_json::Value>) -> Option<serde_json::Value> {
    match v {
        Some(serde_json::Value::String(s)) if !s.trim().is_empty() => {
            Some(serde_json::Value::String(s.trim().into()))
        }
        Some(serde_json::Value::Number(n)) => Some(serde_json::Value::String(n.to_string())),
        _ => None,
    }
}

fn plain_list(dir: &Path) -> Vec<ExtensionInfo> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<ExtensionInfo> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('_') || name.starts_with('.') {
                return None;
            }
            let p = e.path();
            let is_pkg = p.is_dir() && p.join("__init__.py").is_file();
            if !(is_pkg || (p.is_file() && name.ends_with(".py"))) {
                return None;
            }
            Some(ExtensionInfo {
                name: name.trim_end_matches(".py").to_string(),
                file: name,
                is_package: is_pkg,
                version: None,
                description: None,
                author: None,
                enabled: true,
                example: false,
            })
        })
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn ext_dir(root: &Path) -> std::path::PathBuf {
    let dir = crate::cfgread::get_str(root, "extensions.directory").unwrap_or_else(|| "./extensions".into());
    let p = Path::new(&dir);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

fn blacklist(root: &Path) -> (Vec<String>, bool) {
    let overrides = crate::cfgread::overrides(root);
    if let Some(arr) = overrides
        .get("extensions")
        .and_then(|e| e.get("blacklist"))
        .and_then(|b| b.as_array())
    {
        return (
            arr.iter()
                .filter_map(|v| v.as_str().map(|s| s.trim_end_matches(".py").to_string()))
                .collect(),
            true,
        );
    }
    let list = config::load_doc(root)
        .ok()
        .and_then(|(doc, _)| {
            doc.get("extensions")?.get("blacklist")?.as_array().map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(|s| s.trim_end_matches(".py").to_string()))
                    .collect()
            })
        })
        .unwrap_or_default();
    (list, false)
}

#[tauri::command]
pub async fn list_extensions(app: State<'_, Arc<App>>, id: String) -> Res<Vec<ExtensionInfo>> {
    let rec = app.store.instance(&id)?;
    let inst = Inst::new(&rec.path);
    let dir = ext_dir(&rec.path);
    let mut list = if inst.python().is_file() {
        let mut cmd = tokio::process::Command::new(inst.python());
        cmd.arg("-c")
            .arg(LISTER)
            .arg(&dir)
            .current_dir(&rec.path)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        python::bot_env(&app, &inst, &mut cmd);
        python::hide_window(&mut cmd);
        match cmd.output().await {
            Ok(out) if out.status.success() => {
                serde_json::from_slice::<Vec<ExtensionInfo>>(&out.stdout).unwrap_or_else(|_| plain_list(&dir))
            }
            _ => plain_list(&dir),
        }
    } else {
        plain_list(&dir)
    };
    let (black, _) = blacklist(&rec.path);
    for e in &mut list {
        e.version = text(&e.version);
        e.description = text(&e.description);
        e.author = text(&e.author);
        e.enabled = !black.iter().any(|b| b == &e.name);
        e.example = e.name == "example" && !e.is_package;
    }
    Ok(list)
}

#[tauri::command]
pub async fn set_extension_enabled(
    app: State<'_, Arc<App>>,
    id: String,
    name: String,
    enabled: bool,
) -> Res<SaveResult> {
    let rec = app.store.instance(&id)?;
    let (mut black, from_override) = blacklist(&rec.path);
    if from_override {
        return Err(
            "The list of blocked extensions was changed from Discord, so this switch has no effect. Remove that change under Settings, Extensions first."
                .into(),
        );
    }
    black.retain(|b| b != &name);
    if !enabled {
        black.push(name);
    }
    black.sort();
    let mut changes = Map::new();
    changes.insert(
        "extensions.blacklist".into(),
        Json::Array(black.into_iter().map(Json::String).collect()),
    );
    config::save_changes(&app, &rec.path, &changes).await
}
