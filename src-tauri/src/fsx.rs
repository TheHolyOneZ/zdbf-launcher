use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::error::{Ctx, Res};

pub fn atomic_write(path: &Path, bytes: &[u8]) -> Res<()> {
    let dir = path
        .parent()
        .ctx(|| format!("{} has no parent folder", path.display()))?;
    fs::create_dir_all(dir).ctx(|| format!("Could not create {}", dir.display()))?;
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp).ctx(|| format!("Could not write {}", tmp.display()))?;
        f.write_all(bytes)
            .ctx(|| format!("Could not write {}", tmp.display()))?;
        f.sync_all().ok();
    }
    replace(&tmp, path)
}

pub fn replace(from: &Path, to: &Path) -> Res<()> {
    let mut last = None;
    for attempt in 0..5 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => {
                last = Some(e);
                std::thread::sleep(std::time::Duration::from_millis(40 * (attempt + 1)));
            }
        }
    }
    let _ = fs::remove_file(from);
    Err(format!(
        "Could not save {}: {}",
        to.display(),
        last.map(|e| e.to_string()).unwrap_or_default()
    ))
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Res<()> {
    let text = serde_json::to_vec_pretty(value).ctx(|| "Could not encode JSON".into())?;
    atomic_write(path, &text)
}

pub fn is_empty_dir(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut d| d.next().is_none())
        .unwrap_or(false)
}

pub fn copy_dir(from: &Path, to: &Path, skip: &dyn Fn(&Path) -> bool) -> Res<u64> {
    let mut count = 0;
    fs::create_dir_all(to).ctx(|| format!("Could not create {}", to.display()))?;
    for entry in fs::read_dir(from).ctx(|| format!("Could not read {}", from.display()))? {
        let entry = entry.ctx(|| format!("Could not read {}", from.display()))?;
        let src = entry.path();
        if skip(&src) {
            continue;
        }
        let dst = to.join(entry.file_name());
        let ft = entry
            .file_type()
            .ctx(|| format!("Could not read {}", src.display()))?;
        if ft.is_dir() {
            count += copy_dir(&src, &dst, skip)?;
        } else if ft.is_file() {
            fs::copy(&src, &dst).ctx(|| format!("Could not copy {}", src.display()))?;
            count += 1;
        }
    }
    Ok(count)
}

pub fn dir_size(path: &Path) -> u64 {
    let Ok(rd) = fs::read_dir(path) else { return 0 };
    rd.flatten()
        .map(|e| match e.file_type() {
            Ok(t) if t.is_dir() => dir_size(&e.path()),
            Ok(t) if t.is_file() => e.metadata().map(|m| m.len()).unwrap_or(0),
            _ => 0,
        })
        .sum()
}

pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn rel_slash(base: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(base).ok()?;
    let parts: Vec<String> = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    Some(parts.join("/"))
}

pub fn from_slash(base: &Path, rel: &str) -> PathBuf {
    let mut p = base.to_path_buf();
    for part in rel.split('/') {
        if !part.is_empty() && part != "." && part != ".." {
            p.push(part);
        }
    }
    p
}
