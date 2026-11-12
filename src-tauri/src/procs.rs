#[cfg(unix)]
mod imp {
    pub struct Guard;

    pub fn after_spawn(_pid: u32) -> Option<Guard> {
        Some(Guard)
    }

    pub fn graceful(pid: u32, _guard: Option<&Guard>) -> bool {
        unsafe { libc::kill(pid as i32, libc::SIGTERM) == 0 }
    }

    pub fn force(pid: u32, _guard: Option<&Guard>) {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }

    pub fn alive(pid: u32) -> bool {
        if unsafe { libc::kill(pid as i32, 0) } == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

#[cfg(windows)]
mod imp {
    use std::sync::Mutex;
    use std::time::Duration;

    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Console::{
        AttachConsole, CTRL_C_EVENT, FreeConsole, GenerateConsoleCtrlEvent, SetConsoleCtrlHandler,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation, SetInformationJobObject,
        TerminateJobObject,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA,
        PROCESS_TERMINATE, TerminateProcess,
    };

    static CONSOLE: Mutex<()> = Mutex::new(());
    const STILL_ACTIVE: u32 = 259;

    pub struct Guard(HANDLE);
    unsafe impl Send for Guard {}
    unsafe impl Sync for Guard {}

    impl Drop for Guard {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub fn after_spawn(pid: u32) -> Option<Guard> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                AssignProcessToJobObject(job, process);
                CloseHandle(process);
            }
            Some(Guard(job))
        }
    }

    pub fn graceful(pid: u32, _guard: Option<&Guard>) -> bool {
        let _lock = CONSOLE.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            FreeConsole();
            if AttachConsole(pid) == 0 {
                return false;
            }
            SetConsoleCtrlHandler(None, 1);
            let sent = GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) != 0;
            std::thread::sleep(Duration::from_millis(200));
            FreeConsole();
            std::thread::sleep(Duration::from_millis(50));
            SetConsoleCtrlHandler(None, 0);
            sent
        }
    }

    pub fn force(pid: u32, guard: Option<&Guard>) {
        unsafe {
            if let Some(g) = guard {
                TerminateJobObject(g.0, 1);
            }
            let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
            if !process.is_null() {
                TerminateProcess(process, 1);
                CloseHandle(process);
            }
        }
    }

    pub fn alive(pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if process.is_null() {
                return false;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(process, &mut code) != 0;
            CloseHandle(process);
            ok && code == STILL_ACTIVE
        }
    }
}

pub use imp::*;
