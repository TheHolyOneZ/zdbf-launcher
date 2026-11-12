use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub seq: u64,
    pub time: String,
    pub level: String,
    pub logger: String,
    pub message: String,
    pub trace: Vec<String>,
    pub source: String,
}

static RECORD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3}) \| ([A-Z]+)\s* \| ([^|]*?) \| (.*)$").unwrap()
});

static TOKEN_SHAPE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}").unwrap());

static RICH_LINE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\[\d{2}:\d{2}:\d{2}\] (DEBUG|INFO|WARNING|ERROR|CRITICAL)\s").unwrap());

pub const HIDDEN: &str = "[token hidden]";

pub fn mask(text: &str, secrets: &[String]) -> String {
    let mut out = text.to_string();
    for s in secrets {
        if s.len() >= 16 && out.contains(s.as_str()) {
            out = out.replace(s.as_str(), HIDDEN);
        }
    }
    if TOKEN_SHAPE.is_match(&out) {
        out = TOKEN_SHAPE.replace_all(&out, HIDDEN).into_owned();
    }
    out
}

pub fn is_rich_line(line: &str) -> bool {
    RICH_LINE.is_match(line)
}

pub struct Parser {
    pending: Option<LogLine>,
    partial: String,
}

impl Parser {
    pub fn new() -> Self {
        Self {
            pending: None,
            partial: String::new(),
        }
    }

    pub fn feed(&mut self, chunk: &str, secrets: &[String], seq: &mut u64) -> Vec<LogLine> {
        let mut out = Vec::new();
        self.partial.push_str(chunk);
        let Some(last_nl) = self.partial.rfind('\n') else {
            return out;
        };
        let complete: String = self.partial.drain(..=last_nl).collect();
        for raw in complete.split('\n') {
            let line = raw.trim_end_matches('\r');
            if line.is_empty() {
                continue;
            }
            let line = mask(line, secrets);
            if let Some(c) = RECORD.captures(&line) {
                if let Some(done) = self.pending.take() {
                    out.push(done);
                }
                *seq += 1;
                self.pending = Some(LogLine {
                    seq: *seq,
                    time: c[1].to_string(),
                    level: normalize_level(&c[2]),
                    logger: c[3].trim().to_string(),
                    message: c[4].to_string(),
                    trace: Vec::new(),
                    source: "log".into(),
                });
            } else if let Some(p) = self.pending.as_mut() {
                if p.trace.len() < 400 {
                    p.trace.push(line);
                }
            } else {
                *seq += 1;
                out.push(LogLine {
                    seq: *seq,
                    time: String::new(),
                    level: "INFO".into(),
                    logger: String::new(),
                    message: line,
                    trace: Vec::new(),
                    source: "log".into(),
                });
            }
        }
        out
    }

    pub fn flush(&mut self) -> Option<LogLine> {
        self.pending.take()
    }

    pub fn has_pending(&self) -> bool {
        self.pending.is_some()
    }
}

pub fn normalize_level(l: &str) -> String {
    match l {
        "DEBUG" | "INFO" | "WARNING" | "ERROR" | "CRITICAL" => l.to_string(),
        "WARN" => "WARNING".into(),
        "FATAL" => "CRITICAL".into(),
        _ => "INFO".into(),
    }
}

pub struct Tail {
    pub path: PathBuf,
    pub offset: u64,
}

impl Tail {
    pub fn starting_at_end(path: PathBuf) -> Self {
        let offset = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        Self { path, offset }
    }

    pub fn poll(&mut self) -> String {
        let mut text = String::new();
        let len = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            if let Some((rest, _)) = read_from(&rotated_name(&self.path), self.offset) {
                text.push_str(&rest);
            }
            self.offset = 0;
        }
        if len > self.offset
            && let Some((rest, consumed)) = read_from(&self.path, self.offset)
        {
            self.offset += consumed;
            text.push_str(&rest);
        }
        text
    }
}

fn rotated_name(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".1");
    path.with_file_name(name)
}

const MAX_READ: u64 = 4 * 1024 * 1024;

fn read_from(path: &Path, offset: u64) -> Option<(String, u64)> {
    let mut f = File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    if len <= offset {
        return None;
    }
    let start = offset.max(len.saturating_sub(MAX_READ));
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut buf = Vec::with_capacity((len - start) as usize);
    f.take(len - start).read_to_end(&mut buf).ok()?;
    let cut = buf.iter().rposition(|b| *b == b'\n').map(|i| i + 1).unwrap_or(0);
    buf.truncate(cut);
    let consumed = (start - offset) + buf.len() as u64;
    if start > offset {
        let first = buf
            .iter()
            .position(|b| *b == b'\n')
            .map(|i| i + 1)
            .unwrap_or(buf.len());
        buf.drain(..first);
    }
    Some((String::from_utf8_lossy(&buf).into_owned(), consumed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_records_and_folds_traces() {
        let mut p = Parser::new();
        let mut seq = 0;
        let text = "2026-11-12 16:53:31,041 | INFO     | zdbf.bot | ready as Bot#1 (1) | 2 guilds\n\
2026-11-12 16:53:32,000 | ERROR    | zdbf.ext | boom\nTraceback (most recent call last):\n  File \"x\", line 1\nValueError: x\n\
2026-11-12 16:53:33,000 | WARNING  | zdbf | next\n";
        let mut lines = p.feed(text, &[], &mut seq);
        lines.extend(p.flush());
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].logger, "zdbf.bot");
        assert_eq!(lines[1].level, "ERROR");
        assert_eq!(lines[1].trace.len(), 3);
        assert_eq!(lines[2].level, "WARNING");
    }

    #[test]
    fn keeps_partial_lines() {
        let mut p = Parser::new();
        let mut seq = 0;
        assert!(
            p.feed("2026-11-12 16:53:31,041 | INFO     | a | hel", &[], &mut seq)
                .is_empty()
        );
        let mut out = p.feed("lo\n", &[], &mut seq);
        out.extend(p.flush());
        assert_eq!(out[0].message, "hello");
    }

    #[test]
    fn masks_tokens() {
        let token = "MTA4NzY1NDMyMTA5ODc2NTQzMg.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789AB";
        assert_eq!(
            mask(&format!("token={token} end"), &[]),
            format!("token={HIDDEN} end")
        );
        assert_eq!(
            mask("secret-value-123456789", &["secret-value-123456789".into()]),
            HIDDEN
        );
    }

    #[test]
    fn detects_rich_lines() {
        assert!(is_rich_line("[16:53:31] INFO     ZDBF 2.0.0"));
        assert!(!is_rich_line("Traceback (most recent call last):"));
    }
}
