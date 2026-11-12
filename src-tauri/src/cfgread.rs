use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::paths::Inst;

pub fn overrides(root: &Path) -> Value {
    std::fs::read_to_string(Inst::new(root).overrides())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Object(Default::default()))
}

fn dig<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    let mut cur = v;
    for part in key.split('.') {
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn file_value(root: &Path, key: &str) -> Option<toml_edit::Item> {
    let text = std::fs::read_to_string(Inst::new(root).config()).ok()?;
    let doc: toml_edit::DocumentMut = text.parse().ok()?;
    let mut item = doc.as_item();
    for part in key.split('.') {
        item = item.get(part)?;
    }
    Some(item.clone())
}

pub fn get_str(root: &Path, key: &str) -> Option<String> {
    if let Some(v) = dig(&overrides(root), key).and_then(Value::as_str) {
        return Some(v.to_string());
    }
    file_value(root, key)?.as_str().map(str::to_string)
}

pub fn get_int(root: &Path, key: &str) -> Option<i64> {
    if let Some(v) = dig(&overrides(root), key).and_then(Value::as_i64) {
        return Some(v);
    }
    file_value(root, key)?.as_integer()
}

pub fn logs_dir(root: &Path) -> PathBuf {
    let dir = get_str(root, "logging.directory").unwrap_or_else(|| "./logs".into());
    let p = Path::new(&dir);
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        root.join(p)
    }
}

pub fn health_interval_minutes(root: &Path) -> i64 {
    get_int(root, "diagnostics.health_interval_minutes")
        .unwrap_or(5)
        .max(1)
}
