use crate::config::{sidecar_env, sidecar_path, Paths};
use std::fs::{self, OpenOptions};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use win32job::Job;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Backend {
    job: Job,
    child: Mutex<Option<Child>>,
}

impl Backend {
    pub fn new() -> Result<Self, String> {
        let job = Job::create().map_err(|e| e.to_string())?;
        let mut info = job.query_extended_limit_info().map_err(|e| e.to_string())?;
        info.limit_kill_on_job_close();
        job.set_extended_limit_info(&info).map_err(|e| e.to_string())?;
        Ok(Self { job, child: Mutex::new(None) })
    }

    pub fn spawn(&self, paths: &Paths) -> Result<(), String> {
        let exe = sidecar_path(paths);
        if !exe.exists() {
            return Err(format!("sidecar missing: {}", exe.display()));
        }
        let env = sidecar_env(paths);
        let projects_dir = env.iter().find(|(k, _)| k == "PROJECTS_DIR").map(|(_, v)| v.clone()).unwrap_or_default();
        fs::create_dir_all(&projects_dir).map_err(|e| e.to_string())?;
        let log_dir = paths.data_dir.join("logs");
        fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let log = OpenOptions::new().create(true).append(true).open(log_dir.join("server.log")).map_err(|e| e.to_string())?;
        let err = log.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(&exe)
            .envs(env)
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(err))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("spawn {}: {e}", exe.display()))?;
        // Kill-on-close: if the shell dies, Windows tears the child down with the job.
        self.job.assign_process(child.as_raw_handle() as isize).map_err(|e| e.to_string())?;
        *self.child.lock().unwrap() = Some(child);
        Ok(())
    }

    pub fn kill(&self) {
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn log_path(paths: &Paths) -> String {
        paths.data_dir.join("logs").join("server.log").to_string_lossy().into_owned()
    }
}
