use std::fs::{self, File, OpenOptions};
use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use win32job::Job;
use crate::apps::{sidecar_path, AppSpec, Paths};
use tauri::AppHandle;

const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub struct Backends {
    job: Job,
    children: Mutex<Vec<(String, Child)>>,
}

impl Backends {
    pub fn new() -> Result<Self, String> {
        let job = Job::create().map_err(|e| e.to_string())?;
        let mut info = job.query_extended_limit_info().map_err(|e| e.to_string())?;
        info.limit_kill_on_job_close();
        job.set_extended_limit_info(&info).map_err(|e| e.to_string())?;
        Ok(Self { job, children: Mutex::new(Vec::new()) })
    }

    pub fn spawn(&self, app: &AppHandle, spec: &AppSpec, paths: &Paths) -> Result<(), String> {
        let exe = sidecar_path(paths, spec.sidecar);
        if !exe.exists() { return Err(format!("sidecar missing: {}", exe.display())); }
        let env = (spec.env)(app, paths);
        let data_dir = env.iter().find(|(k, _)| k == "DATA_DIR").map(|(_, v)| v.clone()).unwrap_or_default();
        let log_dir = std::path::Path::new(&data_dir).join("logs");
        fs::create_dir_all(&log_dir).map_err(|e| e.to_string())?;
        let log = OpenOptions::new().create(true).append(true).open(log_dir.join("server.log")).map_err(|e| e.to_string())?;
        let err: File = log.try_clone().map_err(|e| e.to_string())?;
        let child = Command::new(&exe)
            .envs(env)
            .stdin(Stdio::null()).stdout(Stdio::from(log)).stderr(Stdio::from(err))
            .creation_flags(CREATE_NO_WINDOW)
            .spawn().map_err(|e| format!("spawn {}: {e}", exe.display()))?;
        // Kill-on-close: if the launcher dies, Windows tears the child down with the job.
        self.job.assign_process(child.as_raw_handle() as isize).map_err(|e| e.to_string())?;
        self.children.lock().unwrap().push((spec.id.to_string(), child));
        Ok(())
    }

    pub fn is_running(&self, id: &str) -> bool {
        let mut list = self.children.lock().unwrap();
        for (cid, child) in list.iter_mut() {
            if cid == id { return matches!(child.try_wait(), Ok(None)); }
        }
        false
    }

    pub fn kill_all(&self) {
        let mut list = self.children.lock().unwrap();
        for (_, child) in list.iter_mut() { let _ = child.kill(); let _ = child.wait(); }
        list.clear();
    }

    pub fn log_path(paths: &Paths, spec: &AppSpec) -> String {
        paths.data_root.join(spec.id).join("logs").join("server.log").to_string_lossy().into_owned()
    }
}
