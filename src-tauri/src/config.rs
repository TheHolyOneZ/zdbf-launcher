use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::sync::Arc;

use serde::Serialize;
use serde_json::{Map, Value as Json};
use tauri::State;
use toml_edit::{Array, DocumentMut, Item, Table, Value};

use crate::app::App;
use crate::error::{Ctx, Res};
use crate::fsx;
use crate::paths::Inst;
use crate::python;

pub const RESTART: [&str; 6] = [
    "bot.privileged_intents",
    "bot.intents",
    "shards",
    "cluster",
    "database",
    "logging",
];

const KNOWN: [&str; 16] = [
    "bot",
    "status",
    "ui",
    "maintenance",
    "database",
    "logging",
    "extensions",
    "cooldowns",
    "modules",
    "diagnostics",
    "backup",
    "scheduler",
    "shards",
    "cluster",
    "marketplace",
    "dashboard",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigField {
    key: String,
    value: Json,
    in_file: bool,
    #[serde(rename = "override")]
    override_value: Json,
    has_override: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSnapshot {
    path: String,
    exists: bool,
    fields: Vec<ConfigField>,
    unknown_sections: Vec<String>,
    overrides_path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    pub ok: bool,
    pub errors: Vec<String>,
    pub restart: Vec<String>,
}

pub fn needs_restart(key: &str) -> bool {
    RESTART
        .iter()
        .any(|r| key == *r || key.starts_with(&format!("{r}.")))
}

fn item_to_json(item: &Item) -> Json {
    match item {
        Item::Value(v) => value_to_json(v),
        Item::Table(t) => {
            let mut m = Map::new();
            for (k, v) in t.iter() {
                m.insert(k.to_string(), item_to_json(v));
            }
            Json::Object(m)
        }
        Item::ArrayOfTables(a) => Json::Array(
            a.iter()
                .map(|t| {
                    let mut m = Map::new();
                    for (k, v) in t.iter() {
                        m.insert(k.to_string(), item_to_json(v));
                    }
                    Json::Object(m)
                })
                .collect(),
        ),
        Item::None => Json::Null,
    }
}

fn value_to_json(v: &Value) -> Json {
    match v {
        Value::String(s) => Json::String(s.value().clone()),
        Value::Integer(i) => Json::from(*i.value()),
        Value::Float(f) => serde_json::Number::from_f64(*f.value())
            .map(Json::Number)
            .unwrap_or(Json::Null),
        Value::Boolean(b) => Json::Bool(*b.value()),
        Value::Datetime(d) => Json::String(d.value().to_string()),
        Value::Array(a) => Json::Array(a.iter().map(value_to_json).collect()),
        Value::InlineTable(t) => {
            let mut m = Map::new();
            for (k, v) in t.iter() {
                m.insert(k.to_string(), value_to_json(v));
            }
            Json::Object(m)
        }
    }
}

fn json_to_value(j: &Json) -> Res<Value> {
    Ok(match j {
        Json::Bool(b) => Value::from(*b),
        Json::Number(n) => {
            if let Some(i) = n.as_i64() {
                Value::from(i)
            } else {
                Value::from(n.as_f64().unwrap_or(0.0))
            }
        }
        Json::String(s) => Value::from(s.as_str()),
        Json::Array(items) => {
            let mut arr = Array::new();
            for it in items {
                arr.push(json_to_value(it)?);
            }
            Value::Array(arr)
        }
        Json::Null => return Err("A setting cannot be empty.".into()),
        Json::Object(_) => return Err("Tables are edited in the file.".into()),
    })
}

fn flatten(prefix: &str, item: &Item, out: &mut BTreeMap<String, Json>) {
    match item {
        Item::Table(t) => {
            for (k, v) in t.iter() {
                let key = if prefix.is_empty() {
                    k.to_string()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten(&key, v, out);
            }
        }
        Item::None => {}
        other => {
            if !prefix.is_empty() {
                out.insert(prefix.to_string(), item_to_json(other));
            }
        }
    }
}

fn flatten_json(prefix: &str, v: &Json, out: &mut BTreeMap<String, Json>) {
    match v {
        Json::Object(m) => {
            for (k, v) in m {
                let key = if prefix.is_empty() {
                    k.clone()
                } else {
                    format!("{prefix}.{k}")
                };
                flatten_json(&key, v, out);
            }
        }
        other => {
            if !prefix.is_empty() {
                out.insert(prefix.to_string(), other.clone());
            }
        }
    }
}

fn default_template(root: &Path) -> Option<String> {
    fs::read_to_string(root.join("zdbf").join("core").join("default_config.toml")).ok()
}

pub fn load_doc(root: &Path) -> Res<(DocumentMut, bool)> {
    let path = Inst::new(root).config();
    let (text, exists) = match fs::read_to_string(&path) {
        Ok(t) => (t, true),
        Err(_) => (
            default_template(root)
                .ctx(|| "The default settings file of ZDBF is missing. Use Repair.".into())?,
            false,
        ),
    };
    let doc: DocumentMut = text.parse().map_err(|e| {
        format!("config.toml cannot be read: {e}. Open the file and fix it, or use Open the file.")
    })?;
    Ok((doc, exists))
}

fn overrides_map(root: &Path) -> BTreeMap<String, Json> {
    let mut out = BTreeMap::new();
    flatten_json("", &crate::cfgread::overrides(root), &mut out);
    out
}

pub fn snapshot(root: &Path) -> Res<ConfigSnapshot> {
    let inst = Inst::new(root);
    let (doc, exists) = load_doc(root)?;
    let mut file = BTreeMap::new();
    flatten("", doc.as_item(), &mut file);
    let overrides = overrides_map(root);
    let mut keys: Vec<String> = file.keys().cloned().collect();
    for k in overrides.keys() {
        if !file.contains_key(k) {
            keys.push(k.clone());
        }
    }
    keys.sort();
    let fields = keys
        .into_iter()
        .map(|k| ConfigField {
            in_file: file.contains_key(&k),
            value: file.get(&k).cloned().unwrap_or(Json::Null),
            has_override: overrides.contains_key(&k),
            override_value: overrides.get(&k).cloned().unwrap_or(Json::Null),
            key: k,
        })
        .collect();
    let unknown_sections = doc
        .as_table()
        .iter()
        .map(|(k, _)| k.to_string())
        .filter(|k| !KNOWN.contains(&k.as_str()))
        .collect();
    Ok(ConfigSnapshot {
        path: inst.config().display().to_string(),
        exists,
        fields,
        unknown_sections,
        overrides_path: inst.overrides().display().to_string(),
    })
}

fn set_key(doc: &mut DocumentMut, key: &str, value: Value) -> Res<()> {
    let parts: Vec<&str> = key.split('.').collect();
    let (last, path) = parts.split_last().ctx(|| "Empty setting name".into())?;
    let mut table: &mut Table = doc.as_table_mut();
    for p in path {
        if !table.contains_key(p) {
            let mut t = Table::new();
            t.set_implicit(false);
            table.insert(p, Item::Table(t));
        }
        table = table
            .get_mut(p)
            .and_then(Item::as_table_mut)
            .ctx(|| format!("{key} cannot be set here because {p} is not a section"))?;
    }
    match table.get_mut(last) {
        Some(Item::Value(old)) => {
            let decor = old.decor().clone();
            let mut new = value;
            *new.decor_mut() = decor;
            let suffix = old
                .decor()
                .suffix()
                .and_then(|s| s.as_str())
                .unwrap_or("")
                .to_string();
            let lead = suffix.chars().take_while(|c| *c == ' ').count();
            if lead > 0 && (lead == suffix.len() || suffix[lead..].starts_with('#')) {
                let mut plain_old = old.clone();
                plain_old.decor_mut().clear();
                let mut plain_new = new.clone();
                plain_new.decor_mut().clear();
                let delta = plain_old.to_string().chars().count() as i64
                    - plain_new.to_string().chars().count() as i64;
                let width = (lead as i64 + delta).max(1) as usize;
                new.decor_mut()
                    .set_suffix(format!("{}{}", " ".repeat(width), &suffix[lead..]));
            }
            if let (Value::Array(old_arr), Value::Array(new_arr)) = (old.clone(), &mut new)
                && old_arr.to_string().contains('\n')
            {
                let mut decors = std::collections::HashMap::new();
                for v in old_arr.iter() {
                    let mut plain = v.clone();
                    plain.decor_mut().clear();
                    decors.insert(plain.to_string().trim().to_string(), v.decor().clone());
                }
                for v in new_arr.iter_mut() {
                    let key = {
                        let mut plain = v.clone();
                        plain.decor_mut().clear();
                        plain.to_string().trim().to_string()
                    };
                    match decors.get(&key) {
                        Some(d) => *v.decor_mut() = d.clone(),
                        None => v.decor_mut().set_prefix("\n    "),
                    }
                }
                let trailing = old_arr.trailing().as_str().unwrap_or("").to_string();
                new_arr.set_trailing(if trailing.contains('\n') {
                    trailing
                } else {
                    "\n".into()
                });
                new_arr.set_trailing_comma(true);
            }
            *old = new;
        }
        _ => {
            table.insert(last, Item::Value(value));
        }
    }
    Ok(())
}

pub fn apply(doc: &mut DocumentMut, changes: &Map<String, Json>) -> Res<()> {
    for (key, val) in changes {
        set_key(doc, key, json_to_value(val)?)?;
    }
    Ok(())
}

pub async fn check(app: &App, root: &Path, candidate: &str) -> Res<Vec<String>> {
    let inst = Inst::new(root);
    if !inst.python().is_file() {
        return Ok(Vec::new());
    }
    let tmp = inst.meta().join("config.check.toml");
    fsx::atomic_write(&tmp, candidate.as_bytes())?;
    let mut cmd = tokio::process::Command::new(inst.python());
    cmd.args(["-m", "zdbf", "--check", "--config"])
        .arg(&tmp)
        .current_dir(root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    python::bot_env(app, &inst, &mut cmd);
    python::hide_window(&mut cmd);
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("The settings could not be checked: {e}"));
    let _ = fs::remove_file(&tmp);
    let out = out?;
    if out.status.code() == Some(2) {
        let err = String::from_utf8_lossy(&out.stderr);
        let lines: Vec<String> = err
            .lines()
            .map(|l| l.trim_start_matches('✗').trim().to_string())
            .filter(|l| !l.is_empty())
            .filter(|l| !(l.ends_with(':') && l.to_lowercase().starts_with("invalid")))
            .map(|l| l.replace(&tmp.display().to_string(), "config.toml"))
            .collect();
        return Ok(if lines.is_empty() {
            vec!["The settings are not valid.".into()]
        } else {
            lines
        });
    }
    if !matches!(out.status.code(), Some(0) | Some(1)) {
        let err = String::from_utf8_lossy(&out.stderr);
        let last = err
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .to_string();
        return Err(format!("The settings could not be checked: {last}"));
    }
    Ok(Vec::new())
}

pub async fn save_changes(app: &App, root: &Path, changes: &Map<String, Json>) -> Res<SaveResult> {
    let (mut doc, _) = load_doc(root)?;
    apply(&mut doc, changes)?;
    let text = doc.to_string();
    let errors = check(app, root, &text).await?;
    if !errors.is_empty() {
        return Ok(SaveResult {
            ok: false,
            errors,
            restart: Vec::new(),
        });
    }
    fsx::atomic_write(&Inst::new(root).config(), text.as_bytes())?;
    let restart = changes.keys().filter(|k| needs_restart(k)).cloned().collect();
    Ok(SaveResult {
        ok: true,
        errors: Vec::new(),
        restart,
    })
}

fn remove_dotted(v: &mut Json, parts: &[&str]) -> bool {
    let Some((first, rest)) = parts.split_first() else {
        return false;
    };
    let Json::Object(m) = v else { return false };
    if rest.is_empty() {
        return m.remove(*first).is_some();
    }
    let Some(child) = m.get_mut(*first) else {
        return false;
    };
    let removed = remove_dotted(child, rest);
    if removed && child.as_object().map(|o| o.is_empty()).unwrap_or(false) {
        m.remove(*first);
    }
    removed
}

#[tauri::command]
pub fn read_config(app: State<'_, Arc<App>>, id: String) -> Res<ConfigSnapshot> {
    let rec = app.store.instance(&id)?;
    snapshot(&rec.path)
}

#[tauri::command]
pub async fn save_config(
    app: State<'_, Arc<App>>,
    id: String,
    changes: Map<String, Json>,
) -> Res<SaveResult> {
    let rec = app.store.instance(&id)?;
    save_changes(&app, &rec.path, &changes).await
}

#[tauri::command]
pub fn remove_override(app: State<'_, Arc<App>>, id: String, key: String) -> Res<ConfigSnapshot> {
    let rec = app.store.instance(&id)?;
    if app.bots.is_live(&id) {
        return Err(
            "Stop the bot first. A running bot keeps its Discord changes and would write them back.".into(),
        );
    }
    let path = Inst::new(&rec.path).overrides();
    let mut v = crate::cfgread::overrides(&rec.path);
    let parts: Vec<&str> = key.split('.').collect();
    if remove_dotted(&mut v, &parts) {
        let text = serde_json::to_string_pretty(&v).ctx(|| "Could not encode the overrides".into())?;
        fsx::atomic_write(&path, text.as_bytes())?;
    }
    snapshot(&rec.path)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"# header comment

[bot]
prefix = "!"
mention_prefix = true          # allow @Bot <command>
owner_ids = []                 # extra owners
privileged_intents = ["members", "message_content"]

[modules]
core = true
dashboard = false              # web control panel

[dashboard]
capabilities = [
    "view",              # status
    "logs",
]
"#;

    #[test]
    fn untouched_round_trip_is_identical() {
        let doc: DocumentMut = SAMPLE.parse().unwrap();
        assert_eq!(doc.to_string(), SAMPLE);
    }

    #[test]
    fn edits_keep_comments() {
        let mut doc: DocumentMut = SAMPLE.parse().unwrap();
        let mut ch = Map::new();
        ch.insert("bot.mention_prefix".into(), Json::Bool(false));
        ch.insert("modules.dashboard".into(), Json::Bool(true));
        ch.insert("bot.prefix".into(), Json::String("?".into()));
        apply(&mut doc, &ch).unwrap();
        let out = doc.to_string();
        assert!(
            out.contains("mention_prefix = false         # allow @Bot <command>"),
            "{out}"
        );
        assert!(
            out.contains("dashboard = true               # web control panel"),
            "{out}"
        );
        assert!(out.contains("prefix = \"?\"\n"), "{out}");
        assert!(out.starts_with("# header comment"));
    }

    #[test]
    fn adds_missing_keys_and_sections() {
        let mut doc: DocumentMut = SAMPLE.parse().unwrap();
        let mut ch = Map::new();
        ch.insert("modules.cluster".into(), Json::Bool(true));
        ch.insert("backup.max_per_guild".into(), Json::from(50));
        apply(&mut doc, &ch).unwrap();
        let out = doc.to_string();
        let parsed: DocumentMut = out.parse().unwrap();
        assert_eq!(parsed["modules"]["cluster"].as_bool(), Some(true));
        assert_eq!(parsed["backup"]["max_per_guild"].as_integer(), Some(50));
    }

    #[test]
    fn multiline_arrays_stay_multiline() {
        let mut doc: DocumentMut = SAMPLE.parse().unwrap();
        let mut ch = Map::new();
        ch.insert(
            "dashboard.capabilities".into(),
            Json::Array(vec![
                Json::String("view".into()),
                Json::String("logs".into()),
                Json::String("config".into()),
            ]),
        );
        apply(&mut doc, &ch).unwrap();
        let out = doc.to_string();
        assert!(out.contains("\"view\",              # status"), "{out}");
        assert!(out.contains("\n    \"config\",\n]"), "{out}");
    }

    #[test]
    fn real_default_file() {
        let text = include_str!("../tests/fixtures/default_config.toml");
        let mut doc: DocumentMut = text.parse().unwrap();
        assert_eq!(doc.to_string(), text);
        let mut ch = Map::new();
        ch.insert("modules.dashboard".into(), Json::Bool(true));
        let caps: Vec<Json> = [
            "view",
            "logs",
            "chat.read",
            "chat.send",
            "commands.run",
            "extensions",
            "files.read",
            "automations",
            "scheduler",
            "settings",
            "backups",
            "presence",
            "database",
        ]
        .iter()
        .map(|s| Json::String((*s).into()))
        .collect();
        ch.insert("dashboard.capabilities".into(), Json::Array(caps));
        apply(&mut doc, &ch).unwrap();
        let out = doc.to_string();
        assert!(
            out.contains("dashboard = true               # web control panel"),
            "{out}"
        );
        assert!(out.contains("# Off unless you add them:"), "{out}");
        assert!(
            out.contains("\"view\",              # status, statistics, lists"),
            "{out}"
        );
        assert!(out.contains("\n    \"database\",\n"), "{out}");
        let changed: Vec<&str> = text
            .lines()
            .zip(out.lines())
            .filter(|(a, b)| a != b)
            .map(|(a, _)| a)
            .collect();
        assert!(changed.len() < 30, "too much changed: {changed:?}");
        let _: DocumentMut = out.parse().unwrap();
    }

    #[test]
    fn removes_nested_override() {
        let mut v: Json = serde_json::json!({"backup": {"max_per_guild": 50}, "bot": {"prefix": "?"}});
        assert!(remove_dotted(&mut v, &["backup", "max_per_guild"]));
        assert_eq!(v, serde_json::json!({"bot": {"prefix": "?"}}));
    }

    #[test]
    fn restart_keys() {
        assert!(needs_restart("logging.level"));
        assert!(needs_restart("bot.privileged_intents"));
        assert!(!needs_restart("bot.prefix"));
    }
}
