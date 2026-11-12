use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app::App;
use crate::error::{Ctx, Res};
use crate::fsx::{self, now_ms};
use crate::instances;
use crate::release;

const REFRESH_MS: u64 = 12 * 60 * 60 * 1000;
const MAX_ASSET: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocPage {
    path: String,
    title: String,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocsBundle {
    source: String,
    version: Option<String>,
    tag: Option<String>,
    pages: Vec<DocPage>,
    fetched_at: Option<u64>,
    offline: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct RemoteIndex {
    tag: String,
    files: Vec<String>,
    etags: BTreeMap<String, String>,
    fetched_at: u64,
}

pub fn is_doc(rel: &str) -> bool {
    rel == "README.md" || rel == "CHANGELOG.md" || (rel.starts_with("docs/") && rel.ends_with(".md"))
}

fn order_key(path: &str) -> (u8, String) {
    let group = match path {
        "README.md" => 0,
        "docs/README.md" => 1,
        p if p.starts_with("docs/guide/") => 2,
        "docs/dev/README.md" => 3,
        p if p.starts_with("docs/dev/") => 4,
        "CHANGELOG.md" => 9,
        _ => 5,
    };
    let rank = match path {
        "docs/guide/installation.md" => "0",
        "docs/guide/configuration.md" => "1",
        "docs/guide/commands.md" => "2",
        "docs/guide/troubleshooting.md" => "~",
        _ => "",
    };
    (group, format!("{rank}{path}"))
}

pub fn title_of(path: &str, text: &str) -> String {
    for line in text.lines() {
        if let Some(t) = line.strip_prefix("# ") {
            let t = t.trim();
            return t.split(": ").next().unwrap_or(t).trim().to_string();
        }
    }
    path.rsplit('/')
        .next()
        .unwrap_or(path)
        .trim_end_matches(".md")
        .replace('-', " ")
}

fn collect(root: &Path) -> Vec<DocPage> {
    let mut rels = Vec::new();
    for top in ["README.md", "CHANGELOG.md"] {
        if root.join(top).is_file() {
            rels.push(top.to_string());
        }
    }
    walk_md(root, &root.join("docs"), &mut rels);
    let mut pages: Vec<DocPage> = rels
        .into_iter()
        .filter_map(|rel| {
            let text = fs::read_to_string(fsx::from_slash(root, &rel)).ok()?;
            Some(DocPage {
                title: title_of(&rel, &text),
                path: rel,
                text,
            })
        })
        .collect();
    pages.sort_by_key(|p| order_key(&p.path));
    pages
}

fn walk_md(base: &Path, dir: &Path, out: &mut Vec<String>) {
    let Ok(rd) = fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            walk_md(base, &p, out);
        } else if p.extension().map(|x| x == "md").unwrap_or(false)
            && let Some(rel) = fsx::rel_slash(base, &p)
        {
            out.push(rel);
        }
    }
}

fn cache_root(app: &App) -> PathBuf {
    app.data_dir.join("cache").join("docs")
}

async fn refresh_remote(app: &Arc<App>, tag: &str, dir: &Path) -> Res<RemoteIndex> {
    let index_path = dir.join("index.json");
    let mut index: RemoteIndex = fsx::read_json(&index_path).unwrap_or_default();
    if index.tag != tag || index.files.is_empty() {
        let url = format!(
            "{}/repos/{}/git/trees/{tag}?recursive=1",
            release::api_base(),
            release::REPO
        );
        let resp = app
            .http
            .get(&url)
            .header("Accept", "application/vnd.github+json")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|e| format!("GitHub could not be reached: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!("GitHub answered with status {}.", resp.status().as_u16()));
        }
        let v: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        let files: Vec<String> = v
            .get("tree")
            .and_then(|t| t.as_array())
            .map(|a| {
                a.iter()
                    .filter(|e| e.get("type").and_then(|t| t.as_str()) == Some("blob"))
                    .filter_map(|e| e.get("path").and_then(|p| p.as_str()).map(str::to_string))
                    .filter(|p| is_doc(p))
                    .collect()
            })
            .unwrap_or_default();
        index = RemoteIndex {
            tag: tag.into(),
            files,
            etags: BTreeMap::new(),
            fetched_at: 0,
        };
    }
    for rel in index.files.clone() {
        let url = format!("{}/{}/{tag}/{rel}", release::raw_base(), release::REPO);
        let target = fsx::from_slash(&dir.join("files"), &rel);
        let mut req = app.http.get(&url).timeout(Duration::from_secs(20));
        if target.is_file()
            && let Some(etag) = index.etags.get(&rel)
        {
            req = req.header("If-None-Match", etag);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("GitHub could not be reached: {e}"))?;
        if resp.status().as_u16() == 304 {
            continue;
        }
        if !resp.status().is_success() {
            continue;
        }
        if let Some(etag) = resp.headers().get("etag").and_then(|v| v.to_str().ok()) {
            index.etags.insert(rel.clone(), etag.to_string());
        }
        let body = resp.bytes().await.map_err(|e| e.to_string())?;
        fsx::atomic_write(&target, &body)?;
    }
    index.fetched_at = now_ms();
    fsx::write_json(&index_path, &index)?;
    Ok(index)
}

async fn latest_bundle(app: &Arc<App>) -> Res<DocsBundle> {
    let check = release::check(app, false).await;
    let latest = check.latest.ctx(|| {
        check
            .error
            .clone()
            .unwrap_or_else(|| "The newest documentation is not available right now.".into())
    })?;
    let dir = cache_root(app).join(&latest.tag);
    let index: Option<RemoteIndex> = fsx::read_json(&dir.join("index.json"));
    let stale = index
        .as_ref()
        .map(|i| now_ms().saturating_sub(i.fetched_at) > REFRESH_MS)
        .unwrap_or(true);
    let mut offline = false;
    let mut fetched_at = index.as_ref().map(|i| i.fetched_at);
    if stale {
        match refresh_remote(app, &latest.tag, &dir).await {
            Ok(i) => fetched_at = Some(i.fetched_at),
            Err(_) => offline = true,
        }
    }
    let pages = collect(&dir.join("files"));
    if pages.is_empty() {
        return Err(
            "The newest documentation could not be downloaded. Check your internet connection.".into(),
        );
    }
    prune_cache(app, &latest.tag);
    Ok(DocsBundle {
        source: "latest".into(),
        version: Some(latest.version),
        tag: Some(latest.tag),
        pages,
        fetched_at,
        offline,
    })
}

fn prune_cache(app: &App, keep: &str) {
    let Ok(rd) = fs::read_dir(cache_root(app)) else {
        return;
    };
    for e in rd.flatten() {
        if e.file_name().to_string_lossy() != keep {
            let _ = fs::remove_dir_all(e.path());
        }
    }
}

#[tauri::command]
pub async fn docs_bundle(app: State<'_, Arc<App>>, id: Option<String>, source: String) -> Res<DocsBundle> {
    let app = app.inner().clone();
    if source == "installed"
        && let Some(id) = id
    {
        let rec = app.store.instance(&id)?;
        let pages = collect(&rec.path);
        if !pages.is_empty() {
            let meta = instances::read_meta(&rec.path);
            return Ok(DocsBundle {
                source: "installed".into(),
                version: meta.version.or_else(|| instances::pyproject_version(&rec.path)),
                tag: meta.tag,
                pages,
                fetched_at: None,
                offline: false,
            });
        }
    }
    latest_bundle(&app).await
}

fn mime(path: &str) -> Option<&'static str> {
    let ext = path.rsplit('.').next()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        _ => return None,
    })
}

fn clean_rel(path: &str) -> Option<String> {
    let mut parts: Vec<&str> = Vec::new();
    for p in path.split('/') {
        match p {
            "" | "." => {}
            ".." => {
                parts.pop()?;
            }
            other => parts.push(other),
        }
    }
    if parts.is_empty() {
        None
    } else {
        Some(parts.join("/"))
    }
}

#[tauri::command]
pub async fn doc_asset(
    app: State<'_, Arc<App>>,
    id: Option<String>,
    source: String,
    path: String,
) -> Res<String> {
    let app = app.inner().clone();
    let rel = clean_rel(&path).ctx(|| "Unknown image.".into())?;
    let kind = mime(&rel).ctx(|| "Only images can be shown.".into())?;
    let bytes = if source == "installed" {
        let id = id.ctx(|| "No bot selected.".into())?;
        let rec = app.store.instance(&id)?;
        let p = fsx::from_slash(&rec.path, &rel);
        let len = fs::metadata(&p).map(|m| m.len()).unwrap_or(0);
        if len == 0 || len > MAX_ASSET {
            return Err("The image is missing or too large.".into());
        }
        fs::read(&p).ctx(|| format!("Could not read {rel}"))?
    } else {
        let tag = release::load_cache(&app)
            .latest
            .map(|l| l.tag)
            .ctx(|| "No release is known.".into())?;
        let target = cache_root(&app)
            .join(&tag)
            .join("assets")
            .join(rel.replace('/', "__"));
        if let Ok(b) = fs::read(&target) {
            b
        } else {
            let url = format!("{}/{}/{tag}/{rel}", release::raw_base(), release::REPO);
            let resp = app
                .http
                .get(&url)
                .timeout(Duration::from_secs(30))
                .send()
                .await
                .map_err(|e| format!("The image could not be downloaded: {e}"))?;
            if !resp.status().is_success() {
                return Err("The image could not be downloaded.".into());
            }
            let b = resp.bytes().await.map_err(|e| e.to_string())?.to_vec();
            if b.len() as u64 > MAX_ASSET {
                return Err("The image is too large.".into());
            }
            let _ = fsx::atomic_write(&target, &b);
            b
        }
    };
    Ok(format!(
        "data:{kind};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_paths() {
        assert_eq!(
            title_of("docs/guide/x.md", "intro\n# Installation\n"),
            "Installation"
        );
        assert_eq!(
            title_of("README.md", "# ZDBF V2: Zoryx Discord Bot Framework\n"),
            "ZDBF V2"
        );
        assert_eq!(title_of("docs/guide/backups.md", "no heading"), "backups");
        assert!(is_doc("docs/dev/ui-kit.md"));
        assert!(!is_doc("zdbf/README.md"));
        assert_eq!(
            clean_rel("docs/guide/../../assets/banner.png").as_deref(),
            Some("assets/banner.png")
        );
        assert_eq!(clean_rel("../x.png"), None);
    }
}
