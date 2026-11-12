use std::fs;
use std::path::Path;

use base64::Engine;
use serde::Serialize;

#[cfg(unix)]
use crate::error::Ctx;
use crate::error::Res;
use crate::fsx;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenState {
    pub set: bool,
    pub bot_id: Option<String>,
    pub invite_url: Option<String>,
}

pub fn bot_id(token: &str) -> Option<String> {
    let first = token.trim().split('.').next()?;
    let mut padded = first.replace('-', "+").replace('_', "/");
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    let raw = base64::engine::general_purpose::STANDARD.decode(padded).ok()?;
    let id = String::from_utf8(raw).ok()?;
    if id.len() >= 15 && id.len() <= 21 && id.chars().all(|c| c.is_ascii_digit()) {
        Some(id)
    } else {
        None
    }
}

pub fn invite_url(bot_id: &str) -> String {
    format!(
        "https://discord.com/oauth2/authorize?client_id={bot_id}&scope=bot+applications.commands&permissions=8"
    )
}

pub fn state_of(token: Option<String>) -> TokenState {
    match token {
        Some(t) if !t.is_empty() => {
            let id = bot_id(&t);
            TokenState {
                set: true,
                invite_url: id.as_deref().map(invite_url),
                bot_id: id,
            }
        }
        _ => TokenState {
            set: false,
            bot_id: None,
            invite_url: None,
        },
    }
}

pub fn validate(token: &str) -> Res<String> {
    let t = token.trim().trim_matches('"').trim_matches('\'').trim();
    let t = t.strip_prefix("Bot ").unwrap_or(t).trim();
    if t.is_empty() {
        return Err("Paste the bot token first.".into());
    }
    if t.chars().any(|c| c.is_whitespace()) {
        return Err("The token contains spaces. Copy it again from the Developer Portal.".into());
    }
    let parts: Vec<&str> = t.split('.').collect();
    let well_formed = parts.len() == 3
        && parts.iter().all(|p| !p.is_empty())
        && t.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    if !well_formed || bot_id(t).is_none() {
        return Err(
            "This does not look like a bot token. In the Developer Portal open your application, then Bot, and press Reset Token. The client secret and the application ID are something else."
                .into(),
        );
    }
    Ok(t.to_string())
}

pub fn read(env_file: &Path) -> Option<String> {
    let text = fs::read_to_string(env_file).ok()?;
    for line in text.lines() {
        let l = line.trim_start();
        let l = l.strip_prefix("export ").unwrap_or(l);
        if let Some(rest) = l.strip_prefix("DISCORD_TOKEN") {
            let rest = rest.trim_start();
            if let Some(v) = rest.strip_prefix('=') {
                let v = v.trim();
                let v = v.split(" #").next().unwrap_or(v).trim();
                let v = v.trim_matches('"').trim_matches('\'');
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

pub fn write(env_file: &Path, example: &Path, token: &str) -> Res<()> {
    let base = fs::read_to_string(env_file)
        .or_else(|_| fs::read_to_string(example))
        .unwrap_or_else(|_| "DISCORD_TOKEN=\n".into());
    let mut out = String::with_capacity(base.len() + 80);
    let mut done = false;
    for line in base.lines() {
        let l = line.trim_start();
        let l2 = l.strip_prefix("export ").unwrap_or(l);
        if !done
            && l2.starts_with("DISCORD_TOKEN")
            && l2["DISCORD_TOKEN".len()..].trim_start().starts_with('=')
        {
            out.push_str("DISCORD_TOKEN=");
            out.push_str(token);
            done = true;
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    if !done {
        out.push_str("DISCORD_TOKEN=");
        out.push_str(token);
        out.push('\n');
    }
    fsx::atomic_write(env_file, out.as_bytes())?;
    restrict(env_file)
}

#[cfg(unix)]
fn restrict(path: &Path) -> Res<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .ctx(|| format!("Could not protect {}", path.display()))
}

#[cfg(not(unix))]
fn restrict(_path: &Path) -> Res<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "MTA4NzY1NDMyMTA5ODc2NTQzMg.GaBcDe.abcdefghijklmnopqrstuvwxyz0123456789AB";

    #[test]
    fn decodes_bot_id() {
        assert_eq!(bot_id(SAMPLE).as_deref(), Some("1087654321098765432"));
    }

    #[test]
    fn rejects_garbage() {
        assert!(validate("hello").is_err());
        assert!(validate("a.b.c").is_err());
        assert!(validate(SAMPLE).is_ok());
        assert_eq!(validate(&format!("  \"{SAMPLE}\" ")).unwrap(), SAMPLE);
    }

    #[test]
    fn rewrites_env_and_keeps_comments() {
        let dir = std::env::temp_dir().join(format!("zdbf-token-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let env = dir.join(".env");
        fs::write(&env, "# comment\nDISCORD_TOKEN=\n# BOT_OWNER_ID=1\n").unwrap();
        write(&env, &dir.join("missing"), SAMPLE).unwrap();
        let text = fs::read_to_string(&env).unwrap();
        assert_eq!(
            text,
            format!("# comment\nDISCORD_TOKEN={SAMPLE}\n# BOT_OWNER_ID=1\n")
        );
        assert_eq!(read(&env).as_deref(), Some(SAMPLE));
        fs::remove_dir_all(&dir).ok();
    }
}
