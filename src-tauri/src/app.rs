use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU8, Ordering};

use tauri::AppHandle;

use crate::bots::Bots;
use crate::dashboard::Dashboards;
use crate::store::Store;

pub const QUIT_NONE: u8 = 0;
pub const QUIT_EXIT: u8 = 1;
pub const QUIT_RESTART: u8 = 2;

pub struct App {
    pub handle: AppHandle,
    pub data_dir: PathBuf,
    pub store: Store,
    pub bots: Bots,
    pub dashboards: Dashboards,
    pub http: reqwest::Client,
    pub release_lock: tokio::sync::Mutex<()>,
    pub tasks: Mutex<HashSet<String>>,
    quit: AtomicU8,
}

impl App {
    pub fn new(handle: AppHandle, data_dir: PathBuf) -> Self {
        let http = reqwest::Client::builder()
            .user_agent(crate::release::user_agent())
            .connect_timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_default();
        Self {
            store: Store::open(data_dir.join("launcher.json")),
            handle,
            data_dir,
            bots: Bots::default(),
            dashboards: Dashboards::default(),
            http,
            release_lock: tokio::sync::Mutex::new(()),
            tasks: Mutex::new(HashSet::new()),
            quit: AtomicU8::new(QUIT_NONE),
        }
    }

    pub fn quitting(&self) -> bool {
        self.quit.load(Ordering::SeqCst) != QUIT_NONE
    }

    pub fn set_quit(&self, mode: u8) {
        let _ = self
            .quit
            .compare_exchange(QUIT_NONE, mode, Ordering::SeqCst, Ordering::SeqCst);
    }

    pub fn finish_quit(&self) {
        self.dashboards.stop_everything();
        if self.quit.load(Ordering::SeqCst) == QUIT_RESTART {
            self.handle.restart();
        } else {
            self.handle.exit(0);
        }
    }
}
