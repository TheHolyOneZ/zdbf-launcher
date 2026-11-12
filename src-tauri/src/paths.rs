use std::path::{Path, PathBuf};

pub const META_DIR: &str = ".zdbf-launcher";

pub fn default_install_root() -> PathBuf {
    if cfg!(windows)
        && let Some(local) = dirs::data_local_dir()
    {
        return local.join("ZDBF");
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("ZDBF")
}

pub fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for c in name.trim().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            dash = false;
        } else if !dash && !out.is_empty() {
            out.push('-');
            dash = true;
        }
    }
    let out = out.trim_end_matches('-').to_string();
    if out.is_empty() { "bot".into() } else { out }
}

pub struct Inst {
    pub root: PathBuf,
}

impl Inst {
    pub fn new(root: &Path) -> Self {
        Self {
            root: root.to_path_buf(),
        }
    }

    pub fn meta(&self) -> PathBuf {
        self.root.join(META_DIR)
    }

    pub fn meta_file(&self) -> PathBuf {
        self.meta().join("instance.json")
    }

    pub fn manifest(&self) -> PathBuf {
        self.meta().join("manifest.json")
    }

    pub fn pidfile(&self) -> PathBuf {
        self.meta().join("bot.pid")
    }

    pub fn runs(&self) -> PathBuf {
        self.meta().join("runs.jsonl")
    }

    pub fn run_output_dir(&self) -> PathBuf {
        self.meta().join("runs")
    }

    pub fn backups(&self) -> PathBuf {
        self.meta().join("backups")
    }

    pub fn dashboard(&self) -> PathBuf {
        self.meta().join("dashboard")
    }

    pub fn venv(&self) -> PathBuf {
        self.root.join(".venv")
    }

    pub fn python(&self) -> PathBuf {
        if cfg!(windows) {
            self.venv().join("Scripts").join("python.exe")
        } else {
            self.venv().join("bin").join("python")
        }
    }

    pub fn pyproject(&self) -> PathBuf {
        self.root.join("pyproject.toml")
    }

    pub fn has_code(&self) -> bool {
        self.pyproject().is_file() && self.root.join("zdbf").join("__main__.py").is_file()
    }

    pub fn env_file(&self) -> PathBuf {
        self.root.join(".env")
    }

    pub fn config(&self) -> PathBuf {
        self.root.join("config.toml")
    }

    pub fn data(&self) -> PathBuf {
        self.root.join("data")
    }

    pub fn diagnostics(&self) -> PathBuf {
        self.data().join("diagnostics.json")
    }

    pub fn overrides(&self) -> PathBuf {
        self.data().join("config_overrides.json")
    }

    pub fn extensions(&self) -> PathBuf {
        self.root.join("extensions")
    }
}
