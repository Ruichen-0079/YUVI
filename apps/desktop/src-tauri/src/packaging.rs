//! Development vs packaged layout resolution for the desktop supervisor.
//! No secrets, tokens, or user credentials appear in argv or public diagnostics.

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SupervisorLaunchMode {
    Development,
    Packaged,
}

#[derive(Debug, Clone)]
pub struct DevelopmentLaunch {
    pub repo_root: PathBuf,
    pub supervisor_script: PathBuf,
}

#[derive(Debug, Clone)]
pub struct PackagedLaunch {
    pub resource_root: PathBuf,
    pub supervisor_exe: Option<PathBuf>,
    pub supervisor_cjs: PathBuf,
    pub bundled_node: PathBuf,
    pub runtime_manifest: PathBuf,
    pub mem0_manifest: PathBuf,
    pub mem0_executable: PathBuf,
    pub local_stt_manifest: PathBuf,
    pub local_stt_executable: PathBuf,
    pub local_stt_models: PathBuf,
    pub state_root: PathBuf,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Mem0Manifest {
    schema_version: u8,
    protocol_version: u8,
    profile_snapshot_mode: String,
    platform: String,
    arch: String,
    executable: String,
    health_path: String,
    default_host: String,
    default_port: u16,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalSttManifest {
    schema_version: u8,
    protocol_version: u8,
    platform: String,
    arch: String,
    executable: String,
    model_directory: String,
    model_manifest: String,
    health_path: String,
    default_host: String,
    default_port: u16,
}

#[derive(Debug, Clone)]
pub enum SupervisorLaunchPlan {
    Development(DevelopmentLaunch),
    Packaged(PackagedLaunch),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PackagingDiagnostics {
    pub mode: String,
    pub ok: bool,
    pub error: Option<String>,
    pub resource_root: Option<String>,
    pub supervisor_exe: Option<String>,
    pub supervisor_cjs: Option<String>,
    pub bundled_node: Option<String>,
    pub runtime_manifest: Option<String>,
    pub mem0_manifest: Option<String>,
    pub mem0_executable: Option<String>,
    pub local_stt_manifest: Option<String>,
    pub local_stt_executable: Option<String>,
    pub local_stt_models: Option<String>,
    pub state_root: Option<String>,
    pub repo_root: Option<String>,
}

impl PackagingDiagnostics {
    pub fn from_plan(plan: &SupervisorLaunchPlan) -> Self {
        match plan {
            SupervisorLaunchPlan::Development(dev) => Self {
                mode: "development".into(),
                ok: true,
                error: None,
                resource_root: None,
                supervisor_exe: None,
                supervisor_cjs: None,
                bundled_node: None,
                runtime_manifest: None,
                mem0_manifest: None,
                mem0_executable: None,
                local_stt_manifest: None,
                local_stt_executable: None,
                local_stt_models: None,
                state_root: None,
                repo_root: Some(dev.repo_root.display().to_string()),
            },
            SupervisorLaunchPlan::Packaged(pkg) => Self {
                mode: "packaged".into(),
                ok: true,
                error: None,
                resource_root: Some(pkg.resource_root.display().to_string()),
                supervisor_exe: pkg.supervisor_exe.as_ref().map(|p| p.display().to_string()),
                supervisor_cjs: Some(pkg.supervisor_cjs.display().to_string()),
                bundled_node: Some(pkg.bundled_node.display().to_string()),
                runtime_manifest: Some(pkg.runtime_manifest.display().to_string()),
                mem0_manifest: Some(pkg.mem0_manifest.display().to_string()),
                mem0_executable: Some(pkg.mem0_executable.display().to_string()),
                local_stt_manifest: Some(pkg.local_stt_manifest.display().to_string()),
                local_stt_executable: Some(pkg.local_stt_executable.display().to_string()),
                local_stt_models: Some(pkg.local_stt_models.display().to_string()),
                state_root: Some(pkg.state_root.display().to_string()),
                repo_root: None,
            },
        }
    }

    pub fn error(mode: &str, message: impl Into<String>) -> Self {
        Self {
            mode: mode.into(),
            ok: false,
            error: Some(message.into()),
            resource_root: None,
            supervisor_exe: None,
            supervisor_cjs: None,
            bundled_node: None,
            runtime_manifest: None,
            mem0_manifest: None,
            mem0_executable: None,
            local_stt_manifest: None,
            local_stt_executable: None,
            local_stt_models: None,
            state_root: None,
            repo_root: None,
        }
    }
}

/// Default mode: debug → development, release → packaged.
/// Override with YUVI_SUPERVISOR_MODE=development|packaged (tests only).
pub fn resolve_launch_mode() -> SupervisorLaunchMode {
    if let Ok(raw) = std::env::var("YUVI_SUPERVISOR_MODE") {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized == "packaged" {
            return SupervisorLaunchMode::Packaged;
        }
        if normalized == "development" || normalized == "dev" {
            return SupervisorLaunchMode::Development;
        }
    }
    if cfg!(debug_assertions) {
        SupervisorLaunchMode::Development
    } else {
        SupervisorLaunchMode::Packaged
    }
}

pub fn resolve_development_launch(repo_root: PathBuf) -> Result<DevelopmentLaunch, String> {
    let supervisor_script = repo_root
        .join("scripts")
        .join("yuvi-desktop-supervisor.mts");
    if !supervisor_script.is_file() {
        return Err(format!(
            "missing supervisor script: {}",
            supervisor_script.display()
        ));
    }
    Ok(DevelopmentLaunch {
        repo_root,
        supervisor_script,
    })
}

/// Resolve packaged resources under Tauri resource_dir (or explicit override).
/// Release never falls back to pnpm/tsx/system node.
pub fn resolve_packaged_launch(
    resource_root: PathBuf,
    state_root: PathBuf,
) -> Result<PackagedLaunch, String> {
    if !resource_root.is_dir() {
        return Err(format!(
            "Supervisor resource missing: {}",
            resource_root.display()
        ));
    }

    let supervisor_dir = resource_root.join("supervisor");
    let runtime_dir = resource_root.join("runtime");

    let supervisor_cjs = supervisor_dir.join("yuvi-desktop-supervisor.cjs");
    if !supervisor_cjs.is_file() {
        return Err(format!(
            "Supervisor resource missing (cjs): {}",
            supervisor_cjs.display()
        ));
    }

    let supervisor_exe_candidate = supervisor_dir.join("yuvi-desktop-supervisor.exe");
    let supervisor_exe = if supervisor_exe_candidate.is_file() {
        Some(supervisor_exe_candidate)
    } else {
        None
    };

    let bundled_node = runtime_dir.join("node.exe");
    if !bundled_node.is_file() {
        return Err(format!("Bundled Node missing: {}", bundled_node.display()));
    }

    let runtime_manifest = runtime_dir.join("runtime-manifest.json");
    if !runtime_manifest.is_file() {
        return Err(format!(
            "Runtime manifest invalid or missing: {}",
            runtime_manifest.display()
        ));
    }
    // Lightweight schema check without secrets.
    let manifest_text = fs::read_to_string(&runtime_manifest)
        .map_err(|e| format!("Runtime manifest unreadable: {e}"))?;
    if !manifest_text.contains("\"schemaVersion\"")
        || !manifest_text.contains("yuvi-runtime-server")
    {
        return Err("Runtime manifest invalid: expected schemaVersion and runtime entry".into());
    }
    let runtime_entry = runtime_dir.join("yuvi-runtime-server.mjs");
    if !runtime_entry.is_file() {
        return Err(format!(
            "Runtime entry missing: {}",
            runtime_entry.display()
        ));
    }

    let mem0_dir = resource_root.join("mem0");
    if !mem0_dir.is_dir() {
        return Err(format!("Mem0 resource missing: {}", mem0_dir.display()));
    }
    let mem0_manifest = mem0_dir.join("mem0-manifest.json");
    let manifest_text =
        fs::read_to_string(&mem0_manifest).map_err(|e| format!("Mem0 manifest unreadable: {e}"))?;
    let manifest: Mem0Manifest =
        serde_json::from_str(&manifest_text).map_err(|e| format!("Mem0 manifest invalid: {e}"))?;
    if manifest.schema_version != 1
        || manifest.protocol_version != 2
        || manifest.profile_snapshot_mode != "bounded_snapshot"
        || manifest.platform != "win32"
        || manifest.arch != "x64"
        || manifest.executable != "yuvi-mem0.exe"
        || manifest.health_path != "/health"
        || manifest.default_host != "127.0.0.1"
        || manifest.default_port != 6131
    {
        return Err("Mem0 manifest does not match the fixed schema".into());
    }
    if manifest
        .executable
        .chars()
        .any(|ch| matches!(ch, '/' | '\\' | ':'))
        || manifest.executable == "."
        || manifest.executable == ".."
    {
        return Err("Mem0 executable must be a basename".into());
    }
    let mem0_executable = mem0_dir.join(&manifest.executable);
    let mem0_root = mem0_dir
        .canonicalize()
        .map_err(|e| format!("Mem0 resource unavailable: {e}"))?;
    let mem0_exe_root = mem0_executable
        .canonicalize()
        .map_err(|e| format!("Mem0 executable missing: {e}"))?;
    if !mem0_exe_root.starts_with(&mem0_root) || !mem0_exe_root.is_file() {
        return Err("Mem0 executable must remain inside the mem0 resource directory".into());
    }
    let mem0_internal = mem0_dir.join("_internal");
    if !mem0_internal.is_dir()
        || fs::read_dir(&mem0_internal)
            .map_err(|e| format!("Mem0 _internal unavailable: {e}"))?
            .next()
            .is_none()
    {
        return Err("Mem0 _internal directory is missing or empty".into());
    }

    let local_stt_dir = resource_root.join("local-stt");
    if !local_stt_dir.is_dir() {
        return Err(format!("Local STT resource missing: {}", local_stt_dir.display()));
    }
    let local_stt_manifest = local_stt_dir.join("local-stt-manifest.json");
    let local_manifest_text = fs::read_to_string(&local_stt_manifest)
        .map_err(|e| format!("Local STT manifest unreadable: {e}"))?;
    let local_manifest: LocalSttManifest = serde_json::from_str(&local_manifest_text)
        .map_err(|e| format!("Local STT manifest invalid: {e}"))?;
    if local_manifest.schema_version != 1
        || local_manifest.protocol_version != 1
        || local_manifest.platform != "win32"
        || local_manifest.arch != "x64"
        || local_manifest.executable != "yuvi-local-stt.exe"
        || local_manifest.model_directory != "models"
        || local_manifest.model_manifest != "models.manifest.json"
        || local_manifest.health_path != "/health"
        || local_manifest.default_host != "127.0.0.1"
        || local_manifest.default_port != 9876
    {
        return Err("Local STT manifest does not match the fixed schema".into());
    }
    let local_stt_root = local_stt_dir
        .canonicalize()
        .map_err(|e| format!("Local STT resource unavailable: {e}"))?;
    let local_stt_executable = local_stt_dir.join(&local_manifest.executable);
    let local_stt_exe_root = local_stt_executable
        .canonicalize()
        .map_err(|e| format!("Local STT executable missing: {e}"))?;
    if !local_stt_exe_root.starts_with(&local_stt_root) || !local_stt_exe_root.is_file() {
        return Err("Local STT executable must remain inside the local-stt resource directory".into());
    }
    let local_stt_internal = local_stt_dir.join("_internal");
    if !local_stt_internal.is_dir()
        || fs::read_dir(&local_stt_internal)
            .map_err(|e| format!("Local STT _internal unavailable: {e}"))?
            .next()
            .is_none()
    {
        return Err("Local STT _internal directory is missing or empty".into());
    }
    let local_stt_models = local_stt_dir.join(&local_manifest.model_directory);
    if !local_stt_models.is_dir() {
        return Err("Local STT models directory is missing".into());
    }
    let local_stt_model_manifest = local_stt_dir.join(&local_manifest.model_manifest);
    if !local_stt_model_manifest.is_file() {
        return Err("Local STT models manifest is missing".into());
    }

    fs::create_dir_all(&state_root).map_err(|e| format!("state root unavailable: {e}"))?;

    Ok(PackagedLaunch {
        resource_root,
        supervisor_exe,
        supervisor_cjs,
        bundled_node,
        runtime_manifest,
        mem0_manifest,
        mem0_executable,
        local_stt_manifest,
        local_stt_executable,
        local_stt_models,
        state_root,
    })
}

/// Build argv for packaged supervisor. Never includes secrets or tokens.
pub fn packaged_supervisor_args(plan: &PackagedLaunch) -> Vec<String> {
    vec![
        "--mode".into(),
        "packaged".into(),
        "--resource-root".into(),
        plan.resource_root.display().to_string(),
        "--state-root".into(),
        plan.state_root.display().to_string(),
        "--runtime-manifest".into(),
        plan.runtime_manifest.display().to_string(),
        "--mem0-manifest".into(),
        plan.mem0_manifest.display().to_string(),
    ]
}

/// How Rust will launch the packaged supervisor process.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PackagedSupervisorCommand {
    /// Standalone pkg-produced executable.
    Exe { file: PathBuf, args: Vec<String> },
    /// Fallback: bundled node.exe + supervisor.cjs (never system PATH node).
    NodeCjs {
        node: PathBuf,
        cjs: PathBuf,
        args: Vec<String>,
    },
}

/// Prefer supervisor exe when present; otherwise use bundled node + cjs.
/// Never returns a PATH-based node.
pub fn select_packaged_supervisor_command(plan: &PackagedLaunch) -> PackagedSupervisorCommand {
    let args = packaged_supervisor_args(plan);
    if let Some(exe) = &plan.supervisor_exe {
        if exe.is_file() {
            return PackagedSupervisorCommand::Exe {
                file: exe.clone(),
                args,
            };
        }
    }
    PackagedSupervisorCommand::NodeCjs {
        node: plan.bundled_node.clone(),
        cjs: plan.supervisor_cjs.clone(),
        args,
    }
}

pub fn assert_no_secret_in_args(args: &[String]) -> Result<(), String> {
    let joined = args.join(" ").to_ascii_lowercase();
    for needle in [
        "deepseek_api_key",
        "database_url",
        "mem0_pg_connection_string",
        "mem0_llm_api_key",
        "sk-",
        "password=",
        "authorization",
        "bearer ",
    ] {
        if joined.contains(needle) {
            return Err("secret-like content must not appear in supervisor argv".into());
        }
    }
    Ok(())
}

pub fn discover_repo_root() -> Result<PathBuf, String> {
    let mut dir = std::env::current_dir().map_err(|e| e.to_string())?;
    for _ in 0..8 {
        if dir.join("pnpm-workspace.yaml").exists() && dir.join("apps").join("desktop").exists() {
            return Ok(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut dir = exe;
        for _ in 0..10 {
            if dir.join("pnpm-workspace.yaml").exists() {
                return Ok(dir);
            }
            if !dir.pop() {
                break;
            }
        }
    }
    Err("could not locate YUVI repository root for supervisor".to_string())
}

/// Root state directory for the packaged Supervisor (passed as the Node
/// Supervisor's data root). Windows keeps `%LOCALAPPDATA%/YUVI/DesktopSupervisor`.
/// Unix follows XDG data-home semantics: `$XDG_DATA_HOME/YUVI/DesktopSupervisor`
/// (default `$HOME/.local/share/YUVI/DesktopSupervisor`). A temporary fallback
/// remains only for environments without any absolute home/data base; durable
/// data there is best-effort and never relied on by the Linux product path.
pub fn desktop_state_dir() -> PathBuf {
  if let Ok(explicit) = std::env::var("YUVI_SUPERVISOR_STATE_ROOT") {
    let trimmed = explicit.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_absolute() {
      return PathBuf::from(trimmed);
    }
  }
  #[cfg(target_os = "windows")]
  {
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
      if !local.trim().is_empty() {
        return PathBuf::from(local).join("YUVI").join("DesktopSupervisor");
      }
    }
  }
  #[cfg(not(target_os = "windows"))]
  {
    if let Some(data_home) = unix_xdg_data_home() {
      return data_home.join("YUVI").join("DesktopSupervisor");
    }
  }
  std::env::temp_dir().join("YUVI-DesktopSupervisor")
}

/// XDG data home per the XDG Base Directory spec: `$XDG_DATA_HOME` when
/// absolute, else `$HOME/.local/share`. `None` when no absolute base exists.
#[cfg(not(target_os = "windows"))]
pub fn unix_xdg_data_home() -> Option<PathBuf> {
  if let Ok(xdg) = std::env::var("XDG_DATA_HOME") {
    let trimmed = xdg.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_absolute() {
      return Some(PathBuf::from(trimmed));
    }
  }
  let home = std::env::var("HOME").ok()?;
  let trimmed = home.trim();
  if trimmed.is_empty() || !Path::new(trimmed).is_absolute() {
    return None;
  }
  Some(Path::new(trimmed).join(".local").join("share"))
}

/// Prefer resource_dir; fall back to generated layout next to the crate for unit tests.
pub fn default_resource_root_for_tests(base: &Path) -> PathBuf {
    base.join("generated").join("win32-x64")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::Mutex;
    use tempfile::tempdir;

    /// Serializes tests that mutate process-global environment variables.
    /// Locks poisoned by a failed sibling test stay usable for the others.
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn lock_env() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|error| error.into_inner())
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn explicit_supervisor_state_root_wins_on_unix() {
        let _guard = lock_env();
        std::env::set_var("YUVI_SUPERVISOR_STATE_ROOT", "/portable/supervisor");
        std::env::set_var("XDG_DATA_HOME", "/xdg/data");
        std::env::set_var("HOME", "/home/yuvi");
        assert_eq!(desktop_state_dir(), PathBuf::from("/portable/supervisor"));
        std::env::remove_var("YUVI_SUPERVISOR_STATE_ROOT");
        std::env::remove_var("XDG_DATA_HOME");
        std::env::remove_var("HOME");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn unix_state_dir_follows_xdg_data_home() {
        let _guard = lock_env();
        std::env::remove_var("LOCALAPPDATA");
        std::env::set_var("XDG_DATA_HOME", "/xdg/data");
        std::env::set_var("HOME", "/home/yuvi");
        assert_eq!(
            desktop_state_dir(),
            PathBuf::from("/xdg/data/YUVI/DesktopSupervisor")
        );
        std::env::remove_var("XDG_DATA_HOME");
        assert_eq!(
            desktop_state_dir(),
            PathBuf::from("/home/yuvi/.local/share/YUVI/DesktopSupervisor")
        );
        std::env::remove_var("HOME");
        std::env::remove_var("XDG_DATA_HOME");
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn unix_xdg_data_home_requires_absolute_bases() {
        let _guard = lock_env();
        std::env::set_var("XDG_DATA_HOME", "relative/data");
        std::env::set_var("HOME", "/home/yuvi");
        assert_eq!(unix_xdg_data_home(), Some(PathBuf::from("/home/yuvi/.local/share")));
        std::env::set_var("XDG_DATA_HOME", "/xdg/data");
        assert_eq!(unix_xdg_data_home(), Some(PathBuf::from("/xdg/data")));
        std::env::set_var("HOME", "");
        std::env::set_var("XDG_DATA_HOME", "");
        assert_eq!(unix_xdg_data_home(), None);
        std::env::remove_var("HOME");
        std::env::remove_var("XDG_DATA_HOME");
    }

    #[test]
    #[cfg(target_os = "windows")]
    fn windows_state_dir_prefers_localappdata() {
        let _guard = lock_env();
        std::env::set_var("LOCALAPPDATA", "C:\\Users\\yuvi\\AppData\\Local");
        assert_eq!(
            desktop_state_dir(),
            PathBuf::from("C:\\Users\\yuvi\\AppData\\Local\\YUVI\\DesktopSupervisor")
        );
        std::env::remove_var("LOCALAPPDATA");
    }

    fn write_mem0_fixture(root: &Path) {
        let mem0 = root.join("mem0");
        fs::create_dir_all(mem0.join("_internal")).unwrap();
        fs::write(mem0.join("yuvi-mem0.exe"), b"MZ").unwrap();
        fs::write(mem0.join("_internal").join("placeholder.dat"), b"x").unwrap();
        fs::write(
      mem0.join("mem0-manifest.json"),
      r#"{"schemaVersion":1,"protocolVersion":2,"profileSnapshotMode":"bounded_snapshot","platform":"win32","arch":"x64","executable":"yuvi-mem0.exe","healthPath":"/health","defaultHost":"127.0.0.1","defaultPort":6131}"#,
    )
    .unwrap();

        let local_stt = root.join("local-stt");
        fs::create_dir_all(local_stt.join("_internal")).unwrap();
        fs::create_dir_all(local_stt.join("models")).unwrap();
        fs::write(local_stt.join("yuvi-local-stt.exe"), b"MZ").unwrap();
        fs::write(local_stt.join("_internal").join("placeholder.dat"), b"x").unwrap();
        fs::write(local_stt.join("models.manifest.json"), b"{\"models\":[],\"runtimeFiles\":[]}").unwrap();
        fs::write(
            local_stt.join("local-stt-manifest.json"),
            r#"{"schemaVersion":1,"protocolVersion":1,"platform":"win32","arch":"x64","executable":"yuvi-local-stt.exe","modelDirectory":"models","modelManifest":"models.manifest.json","healthPath":"/health","defaultHost":"127.0.0.1","defaultPort":9876}"#,
        )
        .unwrap();
    }

    #[test]
    fn development_layout_resolves_repo_script() {
        let dir = tempdir().unwrap();
        let scripts = dir.path().join("scripts");
        fs::create_dir_all(&scripts).unwrap();
        fs::write(scripts.join("yuvi-desktop-supervisor.mts"), "//x\n").unwrap();
        let launch = resolve_development_launch(dir.path().to_path_buf()).unwrap();
        assert!(launch
            .supervisor_script
            .ends_with("yuvi-desktop-supervisor.mts"));
    }

    #[test]
    fn packaged_layout_resolves_resource_tree() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("res");
        let sup = root.join("supervisor");
        let rt = root.join("runtime");
        fs::create_dir_all(&sup).unwrap();
        fs::create_dir_all(&rt).unwrap();
        fs::write(
            sup.join("yuvi-desktop-supervisor.cjs"),
            "module.exports={}\n",
        )
        .unwrap();
        fs::write(rt.join("node.exe"), b"MZ").unwrap();
        fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
        fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
        write_mem0_fixture(&root);
        let state = dir.path().join("state");
        let launch = resolve_packaged_launch(root, state).unwrap();
        assert!(launch.supervisor_cjs.is_file());
        assert!(launch.bundled_node.is_file());
        assert!(launch.runtime_manifest.is_file());
        assert!(launch.mem0_manifest.is_file());
        assert!(launch.mem0_executable.is_file());
        assert!(launch.local_stt_manifest.is_file());
        assert!(launch.local_stt_executable.is_file());
        assert!(launch.local_stt_models.is_dir());
    }

    #[test]
    fn packaged_missing_resource_errors_clearly() {
        let dir = tempdir().unwrap();
        let err = resolve_packaged_launch(dir.path().join("missing"), dir.path().join("state"))
            .unwrap_err();
        assert!(err.to_lowercase().contains("resource"));
    }

    #[test]
    fn packaged_paths_with_spaces_work() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("res with spaces");
        let sup = root.join("supervisor");
        let rt = root.join("runtime");
        fs::create_dir_all(&sup).unwrap();
        fs::create_dir_all(&rt).unwrap();
        fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
        fs::write(rt.join("node.exe"), b"MZ").unwrap();
        fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
        let mut manifest = fs::File::create(rt.join("runtime-manifest.json")).unwrap();
        write!(
      manifest,
      r#"{{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}}"#
    )
    .unwrap();
        write_mem0_fixture(&root);
        let state = dir.path().join("state with spaces");
        let launch = resolve_packaged_launch(root, state).unwrap();
        let args = packaged_supervisor_args(&launch);
        assert!(args.iter().any(|a| a.contains(" ")));
        assert_no_secret_in_args(&args).unwrap();
        assert!(args.iter().any(|arg| arg == "--mem0-manifest"));
    }

    #[test]
    fn packaged_paths_with_non_ascii_work() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("资源目录");
        let sup = root.join("supervisor");
        let rt = root.join("runtime");
        fs::create_dir_all(&sup).unwrap();
        fs::create_dir_all(&rt).unwrap();
        fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
        fs::write(rt.join("node.exe"), b"MZ").unwrap();
        fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
        fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
        write_mem0_fixture(&root);
        let launch = resolve_packaged_launch(root, dir.path().join("状态")).unwrap();
        assert!(launch.resource_root.display().to_string().contains("资源"));
    }

    #[test]
    fn secret_not_in_argv() {
        let args = vec![
            "--mode".into(),
            "packaged".into(),
            "--resource-root".into(),
            "C:\\YUVI\\resources".into(),
        ];
        assert_no_secret_in_args(&args).unwrap();
        let bad = vec!["--env".into(), "DEEPSEEK_API_KEY=sk-test".into()];
        assert!(assert_no_secret_in_args(&bad).is_err());
    }

    #[test]
    fn release_default_mode_is_packaged_in_logic() {
        // Unit test of override only — debug builds default to Development.
        std::env::set_var("YUVI_SUPERVISOR_MODE", "packaged");
        assert_eq!(resolve_launch_mode(), SupervisorLaunchMode::Packaged);
        std::env::set_var("YUVI_SUPERVISOR_MODE", "development");
        assert_eq!(resolve_launch_mode(), SupervisorLaunchMode::Development);
        std::env::remove_var("YUVI_SUPERVISOR_MODE");
    }

    #[test]
    fn packaged_prefers_exe_when_present() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("res");
        let sup = root.join("supervisor");
        let rt = root.join("runtime");
        fs::create_dir_all(&sup).unwrap();
        fs::create_dir_all(&rt).unwrap();
        fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
        fs::write(sup.join("yuvi-desktop-supervisor.exe"), b"MZ").unwrap();
        fs::write(rt.join("node.exe"), b"MZ").unwrap();
        fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
        fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
        write_mem0_fixture(&root);
        let plan = resolve_packaged_launch(root, dir.path().join("state")).unwrap();
        match select_packaged_supervisor_command(&plan) {
            PackagedSupervisorCommand::Exe { file, args } => {
                assert!(file.ends_with("yuvi-desktop-supervisor.exe"));
                assert_no_secret_in_args(&args).unwrap();
                assert!(args.iter().any(|a| a == "packaged"));
            }
            other => panic!("expected Exe, got {other:?}"),
        }
    }

    #[test]
    fn packaged_fallback_uses_bundled_node_not_path() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("res");
        let sup = root.join("supervisor");
        let rt = root.join("runtime");
        fs::create_dir_all(&sup).unwrap();
        fs::create_dir_all(&rt).unwrap();
        fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x\n").unwrap();
        // No supervisor exe → node+cjs fallback
        fs::write(rt.join("node.exe"), b"MZ").unwrap();
        fs::write(rt.join("yuvi-runtime-server.mjs"), "export {}\n").unwrap();
        fs::write(
      rt.join("runtime-manifest.json"),
      r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#,
    )
    .unwrap();
        write_mem0_fixture(&root);
        let plan = resolve_packaged_launch(root.clone(), dir.path().join("state")).unwrap();
        match select_packaged_supervisor_command(&plan) {
            PackagedSupervisorCommand::NodeCjs { node, cjs, args } => {
                assert!(node.ends_with("node.exe"));
                assert!(node.starts_with(&root));
                assert!(cjs.ends_with("yuvi-desktop-supervisor.cjs"));
                assert_no_secret_in_args(&args).unwrap();
                // Fallback must not invent system node path.
                assert!(!node
                    .to_string_lossy()
                    .to_ascii_lowercase()
                    .contains("program files"));
            }
            other => panic!("expected NodeCjs fallback, got {other:?}"),
        }
    }

    #[test]
    fn packaged_mem0_manifest_rejects_unknown_fields() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("res");
        let sup = root.join("supervisor");
        let rt = root.join("runtime");
        fs::create_dir_all(&sup).unwrap();
        fs::create_dir_all(&rt).unwrap();
        fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x").unwrap();
        fs::write(rt.join("node.exe"), b"MZ").unwrap();
        fs::write(rt.join("yuvi-runtime-server.mjs"), "x").unwrap();
        fs::write(rt.join("runtime-manifest.json"), r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#).unwrap();
        write_mem0_fixture(&root);
        fs::write(root.join("mem0").join("mem0-manifest.json"), r#"{"schemaVersion":1,"protocolVersion":2,"profileSnapshotMode":"bounded_snapshot","platform":"win32","arch":"x64","executable":"yuvi-mem0.exe","healthPath":"/health","defaultHost":"127.0.0.1","defaultPort":6131,"extra":true}"#).unwrap();
        assert!(resolve_packaged_launch(root, dir.path().join("state")).is_err());
    }

    #[test]
    fn packaged_mem0_requires_internal_contents() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("res");
        let sup = root.join("supervisor");
        let rt = root.join("runtime");
        fs::create_dir_all(&sup).unwrap();
        fs::create_dir_all(&rt).unwrap();
        fs::write(sup.join("yuvi-desktop-supervisor.cjs"), "x").unwrap();
        fs::write(rt.join("node.exe"), b"MZ").unwrap();
        fs::write(rt.join("yuvi-runtime-server.mjs"), "x").unwrap();
        fs::write(rt.join("runtime-manifest.json"), r#"{"schemaVersion":1,"platform":"win32","arch":"x64","nodeExecutable":"node.exe","runtimeEntry":"yuvi-runtime-server.mjs"}"#).unwrap();
        write_mem0_fixture(&root);
        fs::remove_file(root.join("mem0").join("_internal").join("placeholder.dat")).unwrap();
        assert!(resolve_packaged_launch(root, dir.path().join("state")).is_err());
    }
}
