use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::app::App;
use crate::error::Res;
use crate::fsx::{self, now_ms};

pub const REPO: &str = "TheHolyOneZ/ZDBF-V2";
const CHECK_EVERY_MS: u64 = 12 * 60 * 60 * 1000;
const FORCE_MIN_MS: u64 = 60 * 1000;

pub fn api_base() -> String {
    std::env::var("ZDBF_LAUNCHER_GITHUB_API").unwrap_or_else(|_| "https://api.github.com".into())
}

pub fn raw_base() -> String {
    std::env::var("ZDBF_LAUNCHER_GITHUB_RAW").unwrap_or_else(|_| "https://raw.githubusercontent.com".into())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseInfo {
    pub tag: String,
    pub version: String,
    pub name: String,
    pub published_at: String,
    pub notes: String,
    pub url: String,
    #[serde(default)]
    pub tarball: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ReleaseCache {
    pub etag: Option<String>,
    pub checked_at: Option<u64>,
    pub attempted_at: Option<u64>,
    pub rate_limited_until: Option<u64>,
    pub latest: Option<ReleaseInfo>,
    pub all: Vec<ReleaseInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseCheck {
    pub latest: Option<ReleaseInfo>,
    pub checked_at: Option<u64>,
    pub rate_limited_until: Option<u64>,
    pub offline: bool,
    pub error: Option<String>,
}

#[derive(Deserialize)]
struct GhRelease {
    tag_name: String,
    name: Option<String>,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
    published_at: Option<String>,
    html_url: String,
    tarball_url: Option<String>,
}

fn cache_path(app: &App) -> PathBuf {
    app.data_dir.join("cache").join("github").join("releases.json")
}

pub fn load_cache(app: &App) -> ReleaseCache {
    fsx::read_json(&cache_path(app)).unwrap_or_default()
}

pub fn parse_version(tag: &str) -> Option<semver::Version> {
    let v = tag.strip_prefix('v')?;
    let parsed = semver::Version::parse(v).ok()?;
    if parsed.major == 2 && parsed.pre.is_empty() {
        Some(parsed)
    } else {
        None
    }
}

pub fn newer(candidate: &str, current: &str) -> bool {
    match (semver::Version::parse(candidate), semver::Version::parse(current)) {
        (Ok(a), Ok(b)) => a > b,
        _ => candidate != current,
    }
}

pub fn user_agent() -> String {
    format!("ZDBF-Launcher/{}", env!("CARGO_PKG_VERSION"))
}

pub fn changelog_section(text: &str, version: &str) -> Option<String> {
    let mut out = Vec::new();
    let mut on = false;
    for line in text.lines() {
        if let Some(head) = line.strip_prefix("## ") {
            if on {
                break;
            }
            let v = head.split_whitespace().next().unwrap_or("");
            if v.trim_start_matches('v') == version
                || v.trim_start_matches('[').trim_end_matches(']') == version
            {
                on = true;
            }
            continue;
        }
        if on {
            out.push(line);
        }
    }
    let s = out.join("\n").trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

async fn fetch_notes(app: &App, tag: &str, version: &str) -> String {
    let path = app
        .data_dir
        .join("cache")
        .join("github")
        .join(format!("notes-{tag}.md"));
    if let Ok(t) = std::fs::read_to_string(&path) {
        return t;
    }
    let url = format!("{}/{REPO}/{tag}/CHANGELOG.md", raw_base());
    let Ok(resp) = app.http.get(&url).timeout(Duration::from_secs(20)).send().await else {
        return String::new();
    };
    if !resp.status().is_success() {
        return String::new();
    }
    let text = resp.text().await.unwrap_or_default();
    let notes = changelog_section(&text, version).unwrap_or_default();
    if !notes.is_empty() {
        let _ = fsx::atomic_write(&path, notes.as_bytes());
    }
    notes
}

pub async fn check(app: &Arc<App>, force: bool) -> ReleaseCheck {
    let _lock = app.release_lock.lock().await;
    let mut cache = load_cache(app);
    let now = now_ms();
    let due = match cache.checked_at {
        None => true,
        Some(t) => now.saturating_sub(t) > CHECK_EVERY_MS,
    };
    let recently_tried = cache
        .attempted_at
        .map(|t| now.saturating_sub(t) < FORCE_MIN_MS)
        .unwrap_or(false);
    let limited = cache.rate_limited_until.map(|t| t > now).unwrap_or(false);
    if limited || recently_tried || !(due || force) {
        return ReleaseCheck {
            latest: cache.latest.clone(),
            checked_at: cache.checked_at,
            rate_limited_until: cache.rate_limited_until.filter(|t| *t > now),
            offline: false,
            error: None,
        };
    }
    cache.attempted_at = Some(now);
    let url = format!("{}/repos/{REPO}/releases?per_page=30", api_base());
    let mut req = app
        .http
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28")
        .timeout(Duration::from_secs(20));
    if let (Some(etag), Some(_)) = (&cache.etag, &cache.latest) {
        req = req.header("If-None-Match", etag);
    }
    let result = req.send().await;
    let mut error = None;
    let mut offline = false;
    match result {
        Err(e) => {
            offline = e.is_connect() || e.is_timeout() || e.is_request();
            error = Some(if offline {
                "No connection to GitHub. Check your internet connection.".to_string()
            } else {
                format!("GitHub could not be reached: {e}")
            });
        }
        Ok(resp) => {
            let status = resp.status();
            let remaining = header_u64(&resp, "x-ratelimit-remaining");
            let reset = header_u64(&resp, "x-ratelimit-reset");
            if status.as_u16() == 304 {
                cache.checked_at = Some(now);
            } else if (status.as_u16() == 403 || status.as_u16() == 429) && remaining == Some(0) {
                cache.rate_limited_until = reset.map(|r| r * 1000).or(Some(now + 3_600_000));
                error = Some("GitHub's limit for update checks is reached for now.".into());
            } else if !status.is_success() {
                error = Some(format!("GitHub answered with status {}.", status.as_u16()));
            } else {
                let etag = resp
                    .headers()
                    .get("etag")
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string);
                match resp.json::<Vec<GhRelease>>().await {
                    Ok(list) => {
                        let mut all: Vec<(semver::Version, ReleaseInfo)> = list
                            .into_iter()
                            .filter(|r| !r.draft && !r.prerelease)
                            .filter_map(|r| {
                                let v = parse_version(&r.tag_name)?;
                                Some((
                                    v.clone(),
                                    ReleaseInfo {
                                        version: v.to_string(),
                                        name: r.name.unwrap_or_else(|| r.tag_name.clone()),
                                        notes: r.body.unwrap_or_default(),
                                        published_at: r.published_at.unwrap_or_default(),
                                        url: r.html_url,
                                        tarball: r.tarball_url.unwrap_or_else(|| {
                                            format!("{}/repos/{REPO}/tarball/{}", api_base(), r.tag_name)
                                        }),
                                        tag: r.tag_name,
                                    },
                                ))
                            })
                            .collect();
                        all.sort_by(|a, b| b.0.cmp(&a.0));
                        cache.all = all.iter().map(|(_, r)| r.clone()).collect();
                        cache.latest = cache.all.first().cloned();
                        cache.etag = etag;
                        cache.checked_at = Some(now);
                        cache.rate_limited_until = None;
                    }
                    Err(e) => error = Some(format!("GitHub sent an answer the launcher could not read: {e}")),
                }
            }
        }
    }
    if let Some(latest) = cache.latest.as_mut()
        && latest.notes.trim().is_empty()
    {
        latest.notes = fetch_notes(app, &latest.tag, &latest.version).await;
    }
    let _ = fsx::write_json(&cache_path(app), &cache);
    ReleaseCheck {
        latest: cache.latest.clone(),
        checked_at: cache.checked_at,
        rate_limited_until: cache.rate_limited_until.filter(|t| *t > now),
        offline,
        error,
    }
}

fn header_u64(resp: &reqwest::Response, name: &str) -> Option<u64> {
    resp.headers().get(name)?.to_str().ok()?.parse().ok()
}

#[tauri::command]
pub async fn release_check(app: State<'_, Arc<App>>, force: bool) -> Res<ReleaseCheck> {
    let app = app.inner().clone();
    Ok(check(&app, force).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_changelog_section() {
        let text = "# Changelog\n\n## Unreleased\n\n- next\n\n## 2.0.0 - 2026-11-10\n\n- first\n- second\n\n## 1.x\n\nold\n";
        assert_eq!(
            changelog_section(text, "2.0.0").as_deref(),
            Some("- first\n- second")
        );
        assert_eq!(changelog_section(text, "2.1.0"), None);
    }

    #[test]
    fn only_v2_release_tags() {
        assert!(parse_version("v2.0.0").is_some());
        assert!(parse_version("ZDBF-V2").is_none());
        assert!(parse_version("v2.1.0-rc.1").is_none());
        assert!(parse_version("v3.0.0").is_none());
        assert!(newer("2.1.0", "2.0.0"));
        assert!(!newer("2.0.0", "2.0.0"));
    }
}
