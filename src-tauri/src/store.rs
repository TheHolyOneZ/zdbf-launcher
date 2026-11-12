use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::error::Res;
use crate::fsx;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Prefs {
    pub theme: String,
    pub close_to_tray: bool,
    pub launch_at_login: bool,
    pub check_launcher_updates: bool,
    pub last_instance: Option<String>,
}

impl Default for Prefs {
    fn default() -> Self {
        Self {
            theme: "system".into(),
            close_to_tray: false,
            launch_at_login: false,
            check_launcher_updates: true,
            last_instance: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstanceRecord {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
    #[serde(default)]
    pub auto_restart: bool,
    #[serde(default)]
    pub start_with_launcher: bool,
    #[serde(default)]
    pub setup_done: bool,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LauncherFile {
    pub version: u32,
    pub prefs: Prefs,
    pub instances: Vec<InstanceRecord>,
}

pub struct Store {
    path: PathBuf,
    data: Mutex<LauncherFile>,
}

impl Store {
    pub fn open(path: PathBuf) -> Self {
        let data = fsx::read_json::<LauncherFile>(&path).unwrap_or(LauncherFile {
            version: 1,
            ..Default::default()
        });
        Self {
            path,
            data: Mutex::new(data),
        }
    }

    pub fn read<R>(&self, f: impl FnOnce(&LauncherFile) -> R) -> R {
        let guard = self.data.lock().unwrap_or_else(|e| e.into_inner());
        f(&guard)
    }

    pub fn update<R>(&self, f: impl FnOnce(&mut LauncherFile) -> Res<R>) -> Res<R> {
        let mut guard = self.data.lock().unwrap_or_else(|e| e.into_inner());
        let mut next = guard.clone();
        let out = f(&mut next)?;
        next.version = 1;
        fsx::write_json(&self.path, &next)?;
        *guard = next;
        Ok(out)
    }

    pub fn instance(&self, id: &str) -> Res<InstanceRecord> {
        self.read(|f| f.instances.iter().find(|i| i.id == id).cloned())
            .ok_or_else(|| "This bot is no longer in the launcher. Pick another one in the list.".to_string())
    }

    pub fn instances(&self) -> Vec<InstanceRecord> {
        self.read(|f| f.instances.clone())
    }

    pub fn prefs(&self) -> Prefs {
        self.read(|f| f.prefs.clone())
    }
}
