//! Spawns and proxies the Node desktop supervisor for development mode.
//! Control-token never leaves Rust into the React surface.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Default)]
pub struct SupervisorState {
  inner: Mutex<SupervisorInner>,
}

#[derive(Default)]
struct SupervisorInner {
  child: Option<Child>,
  base_url: Option<String>,
  control_token: Option<String>,
  instance_id: Option<String>,
  expected_pid: Option<u32>,
  repo_root: Option<PathBuf>,
  state_dir: Option<PathBuf>,
  owns_supervisor_process: bool,
  poll_stop: bool,
  shutting_down: bool,
}

#[derive(Debug, Deserialize, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EndpointFile {
  host: String,
  port: u16,
  base_url: String,
  instance_id: String,
  pid: u32,
  started_at: String,
  control_token: String,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DesktopRuntimeBinding {
  mode: String,
  ready: bool,
  instance_id: Option<String>,
  runtime_url: Option<String>,
  error: Option<String>,
}

#[tauri::command]
pub fn get_service_status(state: State<'_, SupervisorState>) -> Result<Value, String> {
  let (base, token) = require_endpoint(&state)?;
  http_json("GET", &format!("{base}/v1/status"), None, Some(&token))
}

/// Resolve the Runtime origin through the Supervisor instance already bound to
/// this desktop process. Attach-only release shells must never infer a Runtime
/// from a well-known port when that binding is unavailable or stale.
#[tauri::command]
pub fn get_desktop_runtime_binding(
  state: State<'_, SupervisorState>,
) -> DesktopRuntimeBinding {
  let mode = if attach_existing_requested() { "attach" } else { "owned" };
  match resolve_desktop_runtime_binding(&state, mode == "attach") {
    Ok((instance_id, runtime_url)) => DesktopRuntimeBinding {
      mode: mode.to_string(),
      ready: true,
      instance_id: Some(instance_id),
      runtime_url: Some(runtime_url),
      error: None,
    },
    Err(error) => DesktopRuntimeBinding {
      mode: mode.to_string(),
      ready: false,
      instance_id: None,
      runtime_url: None,
      error: Some(error),
    },
  }
}

/// Explicit retry for the bounded attach-unavailable product state. It only
/// re-runs pointer/endpoint attachment when this desktop has no bound endpoint;
/// it never spawns a Supervisor or scans for arbitrary Runtime ports.
#[tauri::command]
pub fn retry_desktop_runtime_binding(app: AppHandle) -> DesktopRuntimeBinding {
  let mode = if attach_existing_requested() { "attach" } else { "owned" };
  if mode == "attach" {
    let needs_attach = {
      let state = app.state::<SupervisorState>();
      require_endpoint_identity(&state).is_err()
    };
    if needs_attach {
      if let Err(error) = attach_existing_supervisor(&app) {
        return DesktopRuntimeBinding {
          mode: mode.to_string(),
          ready: false,
          instance_id: None,
          runtime_url: None,
          error: Some(error),
        };
      }
    }
  }

  let state = app.state::<SupervisorState>();
  match resolve_desktop_runtime_binding(&state, mode == "attach") {
    Ok((instance_id, runtime_url)) => DesktopRuntimeBinding {
      mode: mode.to_string(),
      ready: true,
      instance_id: Some(instance_id),
      runtime_url: Some(runtime_url),
      error: None,
    },
    Err(error) => DesktopRuntimeBinding {
      mode: mode.to_string(),
      ready: false,
      instance_id: None,
      runtime_url: None,
      error: Some(error),
    },
  }
}

#[tauri::command]
pub fn refresh_services(state: State<'_, SupervisorState>) -> Result<Value, String> {
  let (base, token) = require_endpoint(&state)?;
  http_json("POST", &format!("{base}/v1/refresh"), None, Some(&token))
}

fn native_service_action_allowed(service: &str, action: &str) -> bool {
  matches!(service, "runtime" | "postgres" | "mem0" | "ollama" | "tts_wrapper" | "tts_upstream" | "local_stt") && matches!(action, "start" | "stop" | "restart")
}

#[tauri::command]
pub async fn service_action(
  window: tauri::WebviewWindow,
  state: State<'_, SupervisorState>,
  action: String,
  service_id: String,
) -> Result<Value, String> {
  if !native_service_action_allowed(&service_id, &action) { return Err("Unknown service control action".into()); }
  crate::native_product::confirm_control(&window, &format!("允许对本机服务 {service_id} 执行 {action}？"))?;
  service_action_owned(state, action, service_id)
}

pub(crate) fn service_action_owned(state: State<'_, SupervisorState>, action: String, service_id: String) -> Result<Value, String> {
  let (base, token) = require_endpoint(&state)?;
  let path = match action.as_str() {
    "restart" | "stop" | "start" => format!("{base}/v1/services/{service_id}/{action}"),
    _ => return Err(format!("unsupported action: {action}")),
  };
  http_json("POST", &path, None, Some(&token))
}

/// Push latest user env overrides (incl. secrets + unsets) to a live Supervisor.
/// Body is POSTed over loopback with control token — never via argv or disk files.
pub fn push_runtime_config(
  app: &AppHandle,
  payload: &crate::config::env_export::SupervisorConfigPush,
) -> Result<Value, String> {
  let state = app.state::<SupervisorState>();
  let (base, token) = require_endpoint(&state)?;
  let body = serde_json::to_string(payload).map_err(|e| e.to_string())?;
  // Never log `body` — may contain secrets.
  http_json(
    "POST",
    &format!("{base}/v1/config"),
    Some(&body),
    Some(&token),
  )
}

pub(crate) fn attach_existing_requested() -> bool {
  #[cfg(target_os = "linux")]
  {
    return std::env::var("YUVI_DESKTOP_SUPERVISOR_BINDING")
      .ok()
      .is_some_and(|value| value.trim().eq_ignore_ascii_case("attach"));
  }
  #[cfg(not(target_os = "linux"))]
  {
    false
  }
}

/// Linux release presentation mode: bind to the one Supervisor already owned by
/// the launcher/systemd. This never spawns/adopts a process, pushes bootstrap
/// configuration, or claims the Supervisor's pid/state files.
pub(crate) fn attach_existing_supervisor(app: &AppHandle) -> Result<(), String> {
  use crate::packaging::desktop_state_dir;

  let root_state_dir = desktop_state_dir();
  fs::create_dir_all(&root_state_dir).map_err(|error| error.to_string())?;
  let pointer_path = root_state_dir.join("active-instance.json");
  let (endpoint, instance_state_dir) = wait_for_attached_endpoint(
    &root_state_dir,
    &pointer_path,
    Duration::from_secs(12),
  )?;

  {
    let state = app.state::<SupervisorState>();
    let mut guard = state
      .inner
      .lock()
      .map_err(|_| "supervisor lock poisoned".to_string())?;
    guard.child = None;
    guard.base_url = Some(endpoint.base_url.clone());
    guard.control_token = Some(endpoint.control_token.clone());
    guard.instance_id = Some(endpoint.instance_id.clone());
    guard.expected_pid = None;
    guard.repo_root = None;
    guard.state_dir = Some(instance_state_dir);
    guard.owns_supervisor_process = false;
    guard.poll_stop = false;
    guard.shutting_down = false;
  }

  start_status_poller(app.clone());
  Ok(())
}

pub fn bootstrap_supervisor(
  app: &AppHandle,
  env_overrides: Option<std::collections::BTreeMap<String, String>>,
) -> Result<(), String> {
  use crate::packaging::{
    assert_no_secret_in_args, desktop_state_dir, discover_repo_root,
    resolve_development_launch, resolve_launch_mode, resolve_packaged_launch,
    SupervisorLaunchMode, SupervisorLaunchPlan,
  };

  let root_state_dir = desktop_state_dir();
  fs::create_dir_all(&root_state_dir).map_err(|e| e.to_string())?;
  let active_pointer = root_state_dir.join("active-instance.json");

  let mode = resolve_launch_mode();
  if matches!(mode, SupervisorLaunchMode::Packaged) {
    if let Some(cfg) = app.try_state::<crate::config::ConfigState>() {
      cfg.service
        .ensure_private_postgres_password()
        .map_err(|error| format!("private PostgreSQL secret persist failed: {error}"))?;
    }
  }
  let plan = match mode {
    SupervisorLaunchMode::Development => {
      let repo_root = discover_repo_root()?;
      SupervisorLaunchPlan::Development(resolve_development_launch(repo_root)?)
    }
    SupervisorLaunchMode::Packaged => {
      let resource_root = resolve_packaged_resource_root(app)?;
      let plan = resolve_packaged_launch(resource_root, root_state_dir.clone()).map_err(|e| {
        // Never fall back to pnpm/tsx in packaged/release mode.
        format!("packaging error: {e}")
      })?;
      SupervisorLaunchPlan::Packaged(plan)
    }
  };

  let (mut command, cwd, repo_root_for_state, packaged_data_home) = match &plan {
    SupervisorLaunchPlan::Development(dev) => {
      let command = if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd.exe");
        cmd.args([
          "/d",
          "/c",
          "pnpm",
          "exec",
          "tsx",
          dev.supervisor_script.to_string_lossy().as_ref(),
          "--repo-root",
          dev.repo_root.to_string_lossy().as_ref(),
        ]);
        cmd
      } else if let Some(pnpm) = which_command("pnpm") {
        let mut cmd = Command::new(pnpm);
        cmd.args([
          "exec",
          "tsx",
          dev.supervisor_script.to_string_lossy().as_ref(),
          "--repo-root",
        ])
        .arg(&dev.repo_root);
        cmd
      } else {
        let node = which_command("node")
          .ok_or_else(|| "node/pnpm is required for desktop supervisor".to_string())?;
        let mut cmd = Command::new(node);
        cmd.arg("--import")
          .arg("tsx")
          .arg(&dev.supervisor_script)
          .arg("--repo-root")
          .arg(&dev.repo_root);
        cmd
      };
      (command, dev.repo_root.clone(), Some(dev.repo_root.clone()), None)
    }
    SupervisorLaunchPlan::Packaged(pkg) => {
      use crate::packaging::{select_packaged_supervisor_command, PackagedSupervisorCommand};
      let selected = select_packaged_supervisor_command(pkg);
      let command = match &selected {
        PackagedSupervisorCommand::Exe { file, args } => {
          assert_no_secret_in_args(args)?;
          let mut cmd = Command::new(file);
          cmd.args(args);
          cmd
        }
        PackagedSupervisorCommand::NodeCjs { node, cjs, args } => {
          assert_no_secret_in_args(args)?;
          // Bundled node only — never PATH node.
          let mut cmd = Command::new(node);
          cmd.arg(cjs);
          cmd.args(args);
          cmd
        }
      };
      // cwd is the per-user state root — never the install directory.
      (command, pkg.state_root.clone(), None, pkg.state_root.parent().map(|p| p.to_path_buf()))
    }
  };

  // Propagate the YUVI data home (parent of the packaged state root) so the
  // Node Supervisor's PG/Live2D/Mem0 defaults resolve inside the same durable
  // data home instead of a platform-legacy fallback. Non-secret path only.
  if let Some(data_home) = packaged_data_home {
    command.env("YUVI_DATA_ROOT", data_home);
  }

  // Inject non-secret public overrides only. Credential secrets are applied
  // after the control plane is up via POST /v1/config so they stay in the
  // dynamic override layer and can be cleared without poisoning baseEnv.
  if let Some(overrides) = env_overrides {
    for (key, value) in overrides {
      if value.trim().is_empty() {
        continue;
      }
      if is_secret_env_key(&key) {
        continue;
      }
      command.env(key, value);
    }
  }
  // Keep the desktop process autostart flags on the Supervisor child. pnpm/tsx
  // wrappers must not drop the isolated-smoke "do not autostart" contract.
  for key in [
    "YUVI_AUTOSTART_RUNTIME",
    "YUVI_AUTOSTART_MEM0",
    "YUVI_AUTOSTART_TTS",
    "YUVI_AUTOSTART_LOCAL_STT",
    "YUVI_SUPERVISOR_MODE",
  ] {
    if let Ok(value) = std::env::var(key) {
      command.env(key, value);
    }
  }
  command
    .current_dir(&cwd)
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

  #[cfg(unix)]
  {
    bind_supervisor_child_lifetime(&mut command);
  }

  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    command.creation_flags(CREATE_NO_WINDOW);
  }

  let child = command
    .spawn()
    .map_err(|e| format!("failed to spawn supervisor: {e}"))?;
  let spawned_child_pid = child.id();

  let endpoint = match wait_for_spawned_endpoint(
    &root_state_dir,
    &active_pointer,
    spawned_child_pid,
    Duration::from_secs(25),
  ) {
    Ok(endpoint) => endpoint,
    Err(error) => {
      let _ = stop_supervisor_child_bounded(child);
      return Err(error);
    }
  };
  // Validate endpoint PID is alive and host is loopback.
  if endpoint.host != "127.0.0.1" && endpoint.host != "localhost" && endpoint.host != "::1" {
    return Err("supervisor endpoint host is not loopback".to_string());
  }
  if !process_alive(endpoint.pid) {
    return Err("supervisor endpoint pid is not running (stale)".to_string());
  }
  if endpoint.control_token.len() < 32 {
    return Err("supervisor endpoint missing control token".to_string());
  }

  let instance_state_dir = root_state_dir.join(&endpoint.instance_id);

  {
    let state = app.state::<SupervisorState>();
    let mut guard = state
      .inner
      .lock()
      .map_err(|_| "supervisor lock poisoned".to_string())?;
    guard.child = Some(child);
    guard.base_url = Some(endpoint.base_url.clone());
    guard.control_token = Some(endpoint.control_token.clone());
    guard.instance_id = Some(endpoint.instance_id.clone());
    guard.expected_pid = Some(endpoint.pid);
    guard.repo_root = repo_root_for_state;
    guard.state_dir = Some(instance_state_dir);
    guard.owns_supervisor_process = true;
    guard.poll_stop = false;
    guard.shutting_down = false;
  }

  // Apply full user config (incl. secrets + unsets) as dynamic overrides, then
  // wait for the Supervisor's bootstrap/reconcile contract before returning.
  // This is an explicit ACK barrier, not a timing delay or retry.
  let token = endpoint.control_token.clone();
  let base_url = endpoint.base_url.clone();
  let config_body = app
    .try_state::<crate::config::ConfigState>()
    .and_then(|cfg| cfg.service.supervisor_config_push().ok())
    .and_then(|payload| serde_json::to_string(&payload).ok());
  if let Some(body) = config_body {
    // Never log body — may contain secrets.
    http_json(
      "POST",
      &format!("{base_url}/v1/config"),
      Some(&body),
      Some(&token),
    )
    .map_err(|error| format!("supervisor config barrier failed: {error}"))?;
  }
  http_json(
    "POST",
    &format!("{base_url}/v1/bootstrap"),
    None,
    Some(&token),
  )
  .map_err(|error| format!("supervisor bootstrap barrier failed: {error}"))?;

  // Publish a non-secret readiness marker only after both ACKs above. The
  // Tauri smoke uses this marker as the bootstrap barrier; the Supervisor's
  // active-instance pointer intentionally remains available earlier so the
  // control plane can be reached during startup.
  let ready_marker = root_state_dir.join("tauri-bootstrap-ready.json");
  let ready_payload = serde_json::json!({
    "schemaVersion": 1,
    "instanceId": endpoint.instance_id,
    "supervisorPid": endpoint.pid,
    "tauriPid": std::process::id(),
    "readyAtMs": std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .map(|duration| duration.as_millis())
      .unwrap_or_default()
  });
  fs::write(
    &ready_marker,
    serde_json::to_vec(&ready_payload).map_err(|error| error.to_string())?,
  )
  .map_err(|error| format!("tauri bootstrap readiness marker failed: {error}"))?;

  start_status_poller(app.clone());
  Ok(())
}

fn is_secret_env_key(key: &str) -> bool {
  matches!(
    key,
    "DEEPSEEK_API_KEY"
      | "OPENAI_COMPATIBLE_API_KEY"
      | "DATABASE_URL"
      | "YUVI_POSTGRES_PASSWORD"
      | "PGPASSWORD"
  )
}

#[cfg(test)]
mod tests {
  use super::{is_secret_env_key, stop_supervisor_child_bounded};
  use std::fs;
  use std::process::{Command, Stdio};
  use std::time::{Duration, Instant};

  #[test]
  fn native_service_control_rejects_path_and_action_injection() {
    for id in ["runtime", "postgres", "mem0", "ollama", "tts_wrapper", "tts_upstream", "local_stt"] {
      assert!(super::native_service_action_allowed(id,"restart"));
    }
    for id in ["../config", "runtime/../../config", "runtime?x=1", "tts-wrapper"] {
      assert!(!super::native_service_action_allowed(id,"start"));
    }
    assert!(!super::native_service_action_allowed("runtime","configure"));
  }

  #[test]
  fn openai_compatible_api_key_stays_out_of_supervisor_base_environment() {
    assert!(is_secret_env_key("OPENAI_COMPATIBLE_API_KEY"));
  }

  #[test]
  fn attached_runtime_binding_requires_matching_owned_instance_runtime() {
    let snapshot = serde_json::json!({
      "instanceId": "portable-a",
      "services": [{
        "id": "runtime",
        "ownership": "owned",
        "status": "healthy",
        "url": "http://127.0.0.1:16121/health"
      }]
    });
    let (instance_id, runtime_url) =
      super::runtime_binding_from_snapshot(&snapshot, "portable-a", true)
        .expect("matching owned Runtime should bind");
    assert_eq!(instance_id, "portable-a");
    assert_eq!(runtime_url, "http://127.0.0.1:16121");
  }

  #[test]
  fn attached_runtime_binding_waits_for_supervisor_readiness_and_rejects_unknown_paths() {
    let mut snapshot = serde_json::json!({
      "instanceId": "portable-a",
      "services": [{"id": "runtime", "ownership": "owned", "status": "starting", "url": "http://127.0.0.1:16121/health"}]
    });
    assert!(super::runtime_binding_from_snapshot(&snapshot, "portable-a", true).unwrap_err().contains("not ready"));
    snapshot["services"][0]["status"] = serde_json::json!("healthy");
    assert_eq!(super::runtime_binding_from_snapshot(&snapshot, "portable-a", true).unwrap().1, "http://127.0.0.1:16121");
    snapshot["services"][0]["url"] = serde_json::json!("http://127.0.0.1:16121/other");
    assert!(super::runtime_binding_from_snapshot(&snapshot, "portable-a", true).is_err());
  }

  #[test]
  fn attached_runtime_binding_rejects_stale_instance_identity() {
    let snapshot = serde_json::json!({
      "instanceId": "old-portable",
      "services": [{
        "id": "runtime",
        "ownership": "owned",
        "status": "healthy",
        "url": "http://127.0.0.1:16121"
      }]
    });
    let error = super::runtime_binding_from_snapshot(&snapshot, "portable-a", true)
      .expect_err("stale Supervisor identity must fail closed");
    assert!(error.contains("identity mismatch"));
  }

  #[test]
  fn attached_runtime_binding_rejects_external_or_foreign_runtime() {
    let external = serde_json::json!({
      "instanceId": "portable-a",
      "services": [{
        "id": "runtime",
        "ownership": "external",
        "url": "http://127.0.0.1:6121"
      }]
    });
    let error = super::runtime_binding_from_snapshot(&external, "portable-a", true)
      .expect_err("attach-only desktop must not adopt an external Runtime");
    assert!(error.contains("not owned"));

    let non_loopback = serde_json::json!({
      "instanceId": "portable-a",
      "services": [{
        "id": "runtime",
        "ownership": "owned",
        "status": "healthy",
        "url": "http://192.0.2.10:16121"
      }]
    });
    let error = super::runtime_binding_from_snapshot(&non_loopback, "portable-a", true)
      .expect_err("non-loopback Runtime origin must be rejected");
    assert!(error.contains("loopback"));
  }

  #[test]
  fn supervisor_child_shutdown_reaps_without_an_unbounded_wait() {
    let mut command = if cfg!(target_os = "windows") {
      let mut command = Command::new("cmd.exe");
      command.args(["/d", "/c", "ping 127.0.0.1 -n 30 > nul"]);
      command
    } else {
      let mut command = Command::new("sleep");
      command.arg("30");
      command
    };
    let child = command
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .spawn()
      .expect("test child should spawn");
    let started = Instant::now();

    assert!(stop_supervisor_child_bounded(child));
    assert!(started.elapsed() < Duration::from_secs(5));
  }

  /// The supervisor child owns a descendant (pnpm/tsx/node shape). Killing the
  /// leader alone would orphan the descendant — the owned process group must
  /// reap both.
  #[cfg(unix)]
  #[test]
  fn owned_group_termination_reaps_leader_and_descendants() {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new("sh");
    command
      .arg("-c")
      .arg("sleep 30 & wait")
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let child = command.spawn().expect("grouped test child should spawn");
    let pgid = child.id() as i32;
    let started = Instant::now();

    assert!(stop_supervisor_child_bounded(child));
    assert!(started.elapsed() < Duration::from_secs(8));
    assert!(!super::process_group_has_members(pgid));
  }

  /// A descendant that ignores SIGTERM must still die: the forced stage
  /// SIGKILLs the whole owned group even though the graceful stage failed.
  #[cfg(unix)]
  #[test]
  fn term_ignoring_descendants_are_force_killed_by_the_owned_group() {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new("sh");
    command
      .arg("-c")
      .arg("trap '' TERM; sleep 30 & wait")
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let child = command.spawn().expect("grouped test child should spawn");
    let pgid = child.id() as i32;
    let started = Instant::now();

    assert!(stop_supervisor_child_bounded(child));
    assert!(started.elapsed() < Duration::from_secs(9));
    assert!(!super::process_group_has_members(pgid));
  }

  /// Natural exit: a supervisor that self-exits after the /v1/shutdown drain
  /// is reaped via the fast path, without any signal escalation.
  #[cfg(unix)]
  #[test]
  fn natural_child_exit_needs_no_signal_escalation() {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new("sh");
    command
      .args(["-c", "sleep 1; exit 0"])
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let child = command.spawn().expect("grouped test child should spawn");

    assert!(stop_supervisor_child_bounded(child));
  }

  #[cfg(unix)]
  #[test]
  fn spawned_child_owns_its_group_members_only() {
    use std::os::unix::process::CommandExt;

    let mut ours = Command::new("sleep");
    ours
      .arg("30")
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let ours_child = ours.spawn().expect("ours");
    let mut foreign = Command::new("sleep");
    foreign
      .arg("30")
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let foreign_child = foreign.spawn().expect("foreign");
    assert!(super::spawned_child_owns_pid(ours_child.id(), ours_child.id()));
    assert!(!super::spawned_child_owns_pid(
      ours_child.id(),
      foreign_child.id()
    ));
    let _ = stop_supervisor_child_bounded(ours_child);
    let _ = stop_supervisor_child_bounded(foreign_child);
  }

  #[cfg(unix)]
  #[test]
  fn spawned_child_owns_a_setsid_descendant() {
    use std::os::unix::process::CommandExt;

    let mut leader = Command::new("python3");
    leader
      .arg("-c")
      .arg(
        "import os, time\n\
         child = os.fork()\n\
         if child == 0:\n\
         \tos.setsid()\n\
         \tos.execlp('sleep', 'sleep', '30')\n\
         time.sleep(30)\n",
      )
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let leader_child = leader.spawn().expect("leader");
    std::thread::sleep(Duration::from_millis(200));
    let descendants = unix_children(leader_child.id());
    assert!(
      descendants
        .iter()
        .copied()
        .any(|pid| super::spawned_child_owns_pid(leader_child.id(), pid)),
      "leader {} descendants {:?}",
      leader_child.id(),
      descendants
    );
    for pid in descendants {
      let _ = Command::new("kill")
        .args(["-KILL", &pid.to_string()])
        .status();
    }
    let _ = stop_supervisor_child_bounded(leader_child);
  }

  #[cfg(unix)]
  fn unix_children(parent: u32) -> Vec<u32> {
    let mut pids = Vec::new();
    let Ok(entries) = fs::read_dir("/proc") else {
      return pids;
    };
    for entry in entries.flatten() {
      let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
        continue;
      };
      if super::unix_ppid(pid) == Some(parent) {
        pids.push(pid);
      }
    }
    pids
  }

  fn serve_ok_json() -> (u16, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let handle = std::thread::spawn(move || {
      for stream in listener.incoming().take(64) {
        if let Ok(mut stream) = stream {
          let mut buf = [0u8; 1024];
          let _ = stream.read(&mut buf);
          let body = r#"{"ok":true}"#;
          let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
          );
          let _ = stream.write_all(resp.as_bytes());
          let _ = stream.shutdown(std::net::Shutdown::Both);
        }
      }
    });
    (port, handle)
  }

  fn write_endpoint(dir: &std::path::Path, pid: u32, port: u16, instance: &str) -> std::path::PathBuf {
    let path = dir.join("control-endpoint.json");
    let payload = serde_json::json!({
      "host": "127.0.0.1",
      "port": port,
      "baseUrl": format!("http://127.0.0.1:{port}"),
      "instanceId": instance,
      "pid": pid,
      "startedAt": "2026-09-06T00:00:00.000Z",
      "controlToken": "a".repeat(64),
    });
    fs::write(&path, serde_json::to_vec(&payload).unwrap()).unwrap();
    path
  }

  fn serve_snapshot(instance: &'static str) -> (u16, std::thread::JoinHandle<()>) {
    use std::io::{Read, Write};
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
    let port = listener.local_addr().expect("addr").port();
    let handle = std::thread::spawn(move || {
      for stream in listener.incoming().take(8) {
        if let Ok(mut stream) = stream {
          let mut buf = [0u8; 1024];
          let _ = stream.read(&mut buf);
          let body = serde_json::json!({
            "instanceId": instance,
            "shuttingDown": false,
            "services": [],
            "updatedAt": "2026-09-09T00:00:00.000Z"
          }).to_string();
          let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
          );
          let _ = stream.write_all(response.as_bytes());
          let _ = stream.shutdown(std::net::Shutdown::Both);
        }
      }
    });
    (port, handle)
  }

  #[cfg(unix)]
  #[test]
  fn attached_endpoint_binds_only_the_active_pointer_identity() {
    let root = tempfile::tempdir().unwrap();
    let instance = "attached-inst";
    let (port, _server) = serve_snapshot(instance);
    let instance_dir = root.path().join(instance);
    fs::create_dir_all(&instance_dir).unwrap();
    let endpoint = write_endpoint(&instance_dir, std::process::id(), port, instance);
    let pointer = root.path().join("active-instance.json");
    fs::write(&pointer, serde_json::to_vec(&serde_json::json!({
      "instanceId": instance,
      "pid": std::process::id(),
      "endpointFile": endpoint,
    })).unwrap()).unwrap();
    let (attached, state_dir) = super::wait_for_attached_endpoint(
      root.path(), &pointer, Duration::from_secs(2)
    ).expect("matching active Supervisor should attach");
    assert_eq!(attached.instance_id, instance);
    assert_eq!(attached.pid, std::process::id());
    assert_eq!(state_dir, fs::canonicalize(instance_dir).unwrap());
  }

  #[cfg(unix)]
  #[test]
  fn attached_endpoint_rejects_pointer_escape() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let endpoint = outside.path().join("control-endpoint.json");
    fs::write(&endpoint, "{}").unwrap();
    let pointer = root.path().join("active-instance.json");
    fs::write(&pointer, serde_json::to_vec(&serde_json::json!({
      "instanceId": "foreign",
      "pid": std::process::id(),
      "endpointFile": endpoint,
    })).unwrap()).unwrap();
    let error = super::read_attached_endpoint(root.path(), &pointer)
      .expect_err("pointer escape must fail closed");
    assert!(error.contains("escaped"));
  }

  #[cfg(unix)]
  #[test]
  fn wait_rejects_a_foreign_healthy_supervisor() {
    use std::os::unix::process::CommandExt;

    let root = tempfile::tempdir().unwrap();
    let (port, _server) = serve_ok_json();
    let mut foreign = Command::new("sleep");
    foreign
      .arg("30")
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let foreign_child = foreign.spawn().expect("foreign");
    let endpoint = write_endpoint(root.path(), foreign_child.id(), port, "foreign-inst");
    let pointer = root.path().join("active-instance.json");
    fs::write(
      &pointer,
      serde_json::to_vec(&serde_json::json!({
        "instanceId": "foreign-inst",
        "pid": foreign_child.id(),
        "endpointFile": endpoint,
      }))
      .unwrap(),
    )
    .unwrap();

    let mut ours = Command::new("sleep");
    ours
      .arg("30")
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let ours_child = ours.spawn().expect("ours");
    let err = super::wait_for_spawned_endpoint(
      root.path(),
      &pointer,
      ours_child.id(),
      Duration::from_millis(600),
    )
    .expect_err("foreign healthy endpoint must not bind");
    assert!(err.contains("did not publish a control endpoint"));

    let _ = stop_supervisor_child_bounded(ours_child);
    let _ = stop_supervisor_child_bounded(foreign_child);
  }

  #[cfg(unix)]
  #[test]
  fn wait_binds_to_the_spawned_child_endpoint() {
    use std::os::unix::process::CommandExt;

    let root = tempfile::tempdir().unwrap();
    let (port, _server) = serve_ok_json();
    let mut ours = Command::new("sleep");
    ours
      .arg("30")
      .process_group(0)
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let ours_child = ours.spawn().expect("ours");
    let instance_dir = root.path().join("child-inst");
    fs::create_dir_all(&instance_dir).unwrap();
    write_endpoint(&instance_dir, ours_child.id(), port, "child-inst");
    let pointer = root.path().join("active-instance.json");
    fs::write(&pointer, "{}").unwrap();

    let endpoint = super::wait_for_spawned_endpoint(
      root.path(),
      &pointer,
      ours_child.id(),
      Duration::from_secs(4),
    )
    .expect("spawned child endpoint");
    assert_eq!(endpoint.pid, ours_child.id());
    assert_eq!(endpoint.instance_id, "child-inst");

    let _ = stop_supervisor_child_bounded(ours_child);
  }

  #[cfg(target_os = "linux")]
  #[test]
  fn linux_parent_death_signal_does_not_leave_a_permanent_child() {
    let dir = tempfile::tempdir().unwrap();
    let pid_path = dir.path().join("child.pid");
    let pid_path_str = pid_path.display().to_string();
    let mut owner = Command::new("python3");
    owner
      .arg("-c")
      .arg(format!(
        r#"
import ctypes, os, signal, time
child = os.fork()
if child == 0:
    libc = ctypes.CDLL(None)
    if libc.prctl(1, signal.SIGTERM) != 0:
        os._exit(2)
    if os.getppid() == 1:
        os.kill(os.getpid(), signal.SIGTERM)
    os.execlp("sleep", "sleep", "30")
open({pid_path_str:?}, "w").write(str(child))
time.sleep(0.4)
"#
      ))
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    let status = owner.status().expect("owner");
    assert!(status.success());
    let child_pid: u32 = fs::read_to_string(&pid_path)
      .expect("pid file")
      .trim()
      .parse()
      .expect("pid");
    let deadline = Instant::now() + Duration::from_secs(3);
    while super::process_alive(child_pid) && Instant::now() < deadline {
      std::thread::sleep(Duration::from_millis(50));
    }
    assert!(
      !super::process_alive(child_pid),
      "child {child_pid} survived parent death"
    );
  }

  #[cfg(target_os = "linux")]
  #[test]
  fn bind_supervisor_child_lifetime_keeps_child_while_owner_lives() {
    let mut command = Command::new("sleep");
    command
      .arg("30")
      .stdin(Stdio::null())
      .stdout(Stdio::null())
      .stderr(Stdio::null());
    super::bind_supervisor_child_lifetime(&mut command);
    let child = command.spawn().expect("bound child");
    assert!(super::process_alive(child.id()));
    assert!(stop_supervisor_child_bounded(child));
  }
}

/// Idempotent application-level shutdown. The `/v1/shutdown` request drains
/// owned services (existing Runtime/seal semantics) and the Node supervisor
/// then self-exits; this side only escalates against the process group it
/// spawned. Only owned services/pids are ever signalled.
pub fn shutdown_supervisor(app: &AppHandle) {
  let state = app.state::<SupervisorState>();
  let mut guard = match state.inner.lock() {
    Ok(g) => g,
    Err(_) => return,
  };
  if guard.shutting_down {
    return;
  }
  guard.shutting_down = true;
  guard.poll_stop = true;
  let base = guard.base_url.clone();
  let token = guard.control_token.clone();
  let mut child = guard.child.take();
  let state_dir = guard.state_dir.clone();
  let expected_pid = guard.expected_pid;
  let owns_supervisor_process = guard.owns_supervisor_process;
  guard.base_url = None;
  // Keep token only for the shutdown request below.
  drop(guard);

  // Ask Supervisor to stop owned Runtime/Mem0 (best-effort, short timeout path).
  if let (Some(base), Some(token)) = (base, token) {
    let _ = http_json_with_timeout(
      "POST",
      &format!("{base}/v1/shutdown"),
      None,
      Some(&token),
      Duration::from_secs(5),
    );
  }

  if owns_supervisor_process {
    // Only the Tauri instance that spawned the Supervisor may force its
    // process tree or remove its shared ownership files.
    if let Some(dir) = state_dir.as_ref() {
      force_kill_pid_from_metadata(&dir.join("runtime.pid.json"));
      force_kill_pid_from_metadata(&dir.join("mem0.pid.json"));
    }

    if let Some(child) = child.take() {
      let _ = stop_supervisor_child_bounded(child);
    } else if let Some(pid) = expected_pid {
      force_kill_process_tree(pid);
    }

    let root = crate::packaging::desktop_state_dir();
    let _ = fs::remove_file(root.join("active-instance.json"));
    let _ = fs::remove_file(root.join("tauri-bootstrap-ready.json"));
    let _ = fs::remove_file(root.join("supervisor.instance.lock"));
  }
}

/// Terminal shutdown of the owned supervisor child. Stages, all bounded:
/// 1. natural exit — a `/v1/shutdown` ACK means the Node supervisor drained and
///    is self-exiting; pnpm/tsx wrappers unwind behind it;
/// 2. graceful stop (Unix) — SIGTERM to the owned process group so the Node
///    SIGTERM handler can drain + exit;
/// 3. forced stop — SIGKILL for the group and the direct child (Windows keeps
///    its taskkill /T /F tree kill);
/// 4. orphan sweep (Unix) — descendants that outlived an exited group leader
///    are SIGKILLed after one bounded settle; no owned process survives the
///    owner.
/// The group is only ever signalled because this instance spawned the child as
/// a group leader (`process_group(0)`); there is no name- or port-based sweep.
fn stop_supervisor_child_bounded(mut child: Child) -> bool {
  const NATURAL_EXIT_WAIT: Duration = Duration::from_secs(2);
  const GROUP_GRACE: Duration = Duration::from_millis(1_500);
  const POST_EXIT_SETTLE: Duration = Duration::from_millis(1_500);
  const REAP_WAIT: Duration = Duration::from_millis(1_500);

  let pid = child.id();
  #[cfg(unix)]
  let owned_group = owned_process_group(pid);

  let mut exited = wait_child_exit(&mut child, NATURAL_EXIT_WAIT);

  if !exited {
    #[cfg(unix)]
    {
      match owned_group {
        Some(pgid) => signal_process_group(pgid, libc::SIGTERM),
        // Defensive: ungrouped child (tests). The handle proves the pid is ours.
        None => signal_pid(pid, libc::SIGTERM),
      }
      exited = wait_child_exit(&mut child, GROUP_GRACE);
    }
    if !exited {
      let _ = child.kill();
      #[cfg(unix)]
      if let Some(pgid) = owned_group {
        signal_process_group(pgid, libc::SIGKILL);
      }
      #[cfg(windows)]
      force_kill_process_tree(pid);
      exited = wait_child_exit(&mut child, REAP_WAIT);
    }
  }

  #[cfg(unix)]
  if let Some(pgid) = owned_group {
    if process_group_has_members(pgid) {
      if exited && wait_process_group_empty(pgid, POST_EXIT_SETTLE) {
        return true;
      }
      signal_process_group(pgid, libc::SIGKILL);
      if !wait_process_group_empty(pgid, REAP_WAIT) {
        return false;
      }
    }
  }

  exited
}

fn wait_child_exit(child: &mut Child, budget: Duration) -> bool {
  let deadline = std::time::Instant::now() + budget;
  loop {
    match child.try_wait() {
      Ok(Some(_)) => return true,
      Ok(None) => {
        if std::time::Instant::now() >= deadline {
          return false;
        }
        thread::sleep(Duration::from_millis(50));
      }
      Err(_) => return false,
    }
  }
}

#[cfg(unix)]
mod unix_process {
  /// PgID of `pid`, but only when `pid` itself leads that group — i.e. we
  /// spawned it with `process_group(0)`. Never returns a group this instance
  /// did not create, so callers cannot signal a foreign group.
  pub(super) fn owned_process_group(pid: u32) -> Option<i32> {
    let pid = libc::pid_t::try_from(pid).ok()?;
    let pgid = unsafe { libc::getpgid(pid) };
    if pgid > 0 && pgid == pid { Some(pgid) } else { None }
  }

  /// `kill(-pgid, sig)` — reaches every descendant still in the owned group.
  pub(super) fn signal_process_group(pgid: i32, sig: i32) {
    unsafe {
      libc::kill(-pgid, sig);
    }
  }

  /// Direct-pid signal for a child we hold a live handle for.
  pub(super) fn signal_pid(pid: u32, sig: i32) {
    if let Ok(pid) = libc::pid_t::try_from(pid) {
      unsafe {
        libc::kill(pid, sig);
      }
    }
  }

  /// `kill(-pgid, 0)`: Ok/EPERM ⇒ members exist, ESRCH ⇒ group is empty.
  pub(super) fn process_group_has_members(pgid: i32) -> bool {
    let sent = unsafe { libc::kill(-pgid, 0) };
    if sent == 0 {
      return true;
    }
    std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
  }
}

#[cfg(unix)]
fn owned_process_group(pid: u32) -> Option<i32> {
  unix_process::owned_process_group(pid)
}

#[cfg(unix)]
fn signal_process_group(pgid: i32, sig: i32) {
  unix_process::signal_process_group(pgid, sig)
}

#[cfg(unix)]
fn signal_pid(pid: u32, sig: i32) {
  unix_process::signal_pid(pid, sig)
}

#[cfg(unix)]
fn process_group_has_members(pgid: i32) -> bool {
  unix_process::process_group_has_members(pgid)
}

#[cfg(unix)]
fn wait_process_group_empty(pgid: i32, budget: Duration) -> bool {
  let deadline = std::time::Instant::now() + budget;
  while process_group_has_members(pgid) {
    if std::time::Instant::now() >= deadline {
      return false;
    }
    thread::sleep(Duration::from_millis(50));
  }
  true
}

/// Force-kill a process tree on Windows (taskkill /T /F). On Unix this is a
/// direct-pid backstop for pid-metadata entries (runtime/mem0) that are group
/// members, not leaders — the owned-group escalation in
/// `stop_supervisor_child_bounded` covers their tree.
fn force_kill_process_tree(pid: u32) {
  if pid == 0 {
    return;
  }
  #[cfg(target_os = "windows")]
  {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let _ = Command::new("taskkill")
      .args(["/PID", &pid.to_string(), "/T", "/F"])
      .creation_flags(CREATE_NO_WINDOW)
      .stdout(Stdio::null())
      .stderr(Stdio::null())
      .status();
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = Command::new("kill")
      .args(["-TERM", &pid.to_string()])
      .status();
  }
}

/// Read `{ "pid": N }` metadata and force-kill that tree if present.
fn force_kill_pid_from_metadata(path: &Path) {
  let Ok(text) = fs::read_to_string(path) else {
    return;
  };
  let Ok(value) = serde_json::from_str::<Value>(&text) else {
    return;
  };
  let pid = value
    .get("pid")
    .and_then(|v| v.as_u64())
    .or_else(|| value.get("processId").and_then(|v| v.as_u64()))
    .unwrap_or(0) as u32;
  if pid > 0 {
    force_kill_process_tree(pid);
  }
}

fn start_status_poller(app: AppHandle) {
  thread::spawn(move || {
    let mut last_fingerprint: Option<String> = None;
    loop {
      let (base, token, stop) = {
        let state = app.state::<SupervisorState>();
        let guard = match state.inner.lock() {
          Ok(g) => g,
          Err(_) => break,
        };
        if guard.poll_stop || guard.shutting_down {
          break;
        }
        (
          guard.base_url.clone(),
          guard.control_token.clone(),
          guard.poll_stop,
        )
      };
      if stop {
        break;
      }
      if let (Some(base), Some(token)) = (base, token) {
        if let Ok(snapshot) = http_json("GET", &format!("{base}/v1/status"), None, Some(&token)) {
          // Snapshot must never contain the control token.
          // Skip emit when UI-visible service fields are unchanged (reduces React churn).
          let fingerprint = status_emit_fingerprint(&snapshot);
          if last_fingerprint.as_ref() != Some(&fingerprint) {
            last_fingerprint = Some(fingerprint);
            let _ = app.emit("service.status.changed", snapshot);
          }
        }
      } else {
        break;
      }
      thread::sleep(Duration::from_secs(5));
    }
  });
}

/// Stable fingerprint of status fields that affect the UI (ignores updatedAt).
fn status_emit_fingerprint(snapshot: &Value) -> String {
  let services = snapshot.get("services").cloned().unwrap_or(Value::Null);
  let instance = snapshot
    .get("instanceId")
    .or_else(|| snapshot.get("instance_id"))
    .cloned()
    .unwrap_or(Value::Null);
  let shutting = snapshot
    .get("shuttingDown")
    .or_else(|| snapshot.get("shutting_down"))
    .cloned()
    .unwrap_or(Value::Null);
  // Strip per-check clocks from each service object.
  let stripped = match services {
    Value::Array(items) => Value::Array(
      items
        .into_iter()
        .map(|item| match item {
          Value::Object(mut map) => {
            map.remove("checkedAt");
            map.remove("checked_at");
            map.remove("startedAt");
            map.remove("started_at");
            Value::Object(map)
          }
          other => other,
        })
        .collect(),
    ),
    other => other,
  };
  format!("{instance}|{shutting}|{stripped}")
}

pub(crate) fn native_product(app: &AppHandle, action: &str, body: &Value) -> Result<Value, String> {
  let state = app.state::<SupervisorState>();
  let (base, token, instance) = require_endpoint_identity(&state)?;
  let snapshot = http_json("GET", &format!("{base}/v1/status"), None, Some(&token))?;
  runtime_binding_from_snapshot(&snapshot, &instance, true)?;
  let body = serde_json::to_string(body).map_err(|_| "Native request encoding failed".to_string())?;
  http_json("POST", &format!("{base}/v1/native-product/{action}"), Some(&body), Some(&token))
}

fn require_endpoint(state: &State<'_, SupervisorState>) -> Result<(String, String), String> {
  let (base, token, _) = require_endpoint_identity(state)?;
  Ok((base, token))
}

fn require_endpoint_identity(
  state: &State<'_, SupervisorState>,
) -> Result<(String, String, String), String> {
  let guard = state
    .inner
    .lock()
    .map_err(|_| "supervisor lock poisoned".to_string())?;
  if guard.shutting_down {
    return Err("supervisor is shutting down".to_string());
  }
  let base = guard
    .base_url
    .clone()
    .ok_or_else(|| "desktop supervisor is not running".to_string())?;
  let token = guard
    .control_token
    .clone()
    .ok_or_else(|| "desktop supervisor control token missing".to_string())?;
  let instance_id = guard
    .instance_id
    .clone()
    .ok_or_else(|| "desktop supervisor instance identity missing".to_string())?;
  Ok((base, token, instance_id))
}

fn resolve_desktop_runtime_binding(
  state: &State<'_, SupervisorState>,
  require_owned_runtime: bool,
) -> Result<(String, String), String> {
  let (base, token, expected_instance_id) = require_endpoint_identity(state)?;
  let snapshot = http_json("GET", &format!("{base}/v1/status"), None, Some(&token))
    .map_err(|error| format!("bound Supervisor status unavailable: {error}"))?;
  runtime_binding_from_snapshot(&snapshot, &expected_instance_id, require_owned_runtime)
}

fn runtime_binding_from_snapshot(
  snapshot: &Value,
  expected_instance_id: &str,
  require_owned_runtime: bool,
) -> Result<(String, String), String> {
  let instance_id = snapshot
    .get("instanceId")
    .and_then(Value::as_str)
    .ok_or_else(|| "bound Supervisor status is missing instance identity".to_string())?;
  if instance_id != expected_instance_id {
    return Err("bound Supervisor status identity mismatch".to_string());
  }

  let runtime = snapshot
    .get("services")
    .and_then(Value::as_array)
    .and_then(|services| {
      services
        .iter()
        .find(|service| service.get("id").and_then(Value::as_str) == Some("runtime"))
    })
    .ok_or_else(|| "bound Supervisor did not project a Runtime service".to_string())?;

  if require_owned_runtime
    && runtime.get("ownership").and_then(Value::as_str) != Some("owned")
  {
    return Err("attach-only desktop Runtime is not owned by its bound Supervisor".to_string());
  }

  if require_owned_runtime && runtime.get("status").and_then(Value::as_str) != Some("healthy") {
    return Err("bound Supervisor Runtime is not ready".to_string());
  }

  let runtime_url = runtime
    .get("url")
    .and_then(Value::as_str)
    .ok_or_else(|| "bound Supervisor Runtime URL is unavailable".to_string())?;
  let parsed = url::Url::parse(runtime_url)
    .map_err(|_| "bound Supervisor Runtime URL is invalid".to_string())?;
  if parsed.scheme() != "http"
    || !endpoint_host_is_loopback(parsed.host_str().unwrap_or_default())
    || !parsed.username().is_empty()
    || parsed.password().is_some()
    || !matches!(parsed.path(), "" | "/" | "/health")
    || parsed.query().is_some()
    || parsed.fragment().is_some()
  {
    return Err("bound Supervisor Runtime URL is not a loopback HTTP origin".to_string());
  }

  Ok((
    instance_id.to_string(),
    parsed.origin().ascii_serialization(),
  ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ActivePointer {
  instance_id: String,
  pid: u32,
  endpoint_file: String,
}

fn read_attached_endpoint(
  root_state_dir: &Path,
  pointer_path: &Path,
) -> Result<(EndpointFile, PathBuf), String> {
  let pointer_text = fs::read_to_string(pointer_path)
    .map_err(|error| format!("active Supervisor pointer unavailable: {error}"))?;
  let pointer: ActivePointer = serde_json::from_str(&pointer_text)
    .map_err(|error| format!("active Supervisor pointer invalid: {error}"))?;
  let endpoint_path = PathBuf::from(&pointer.endpoint_file);
  let root = fs::canonicalize(root_state_dir)
    .map_err(|error| format!("Supervisor state root unavailable: {error}"))?;
  let endpoint_path = fs::canonicalize(&endpoint_path)
    .map_err(|error| format!("active Supervisor endpoint unavailable: {error}"))?;
  if !endpoint_path.starts_with(&root) {
    return Err("active Supervisor endpoint escaped the configured state root".to_string());
  }
  let endpoint_text = fs::read_to_string(&endpoint_path)
    .map_err(|error| format!("active Supervisor endpoint unreadable: {error}"))?;
  let endpoint: EndpointFile = serde_json::from_str(&endpoint_text)
    .map_err(|error| format!("active Supervisor endpoint invalid: {error}"))?;
  if endpoint.instance_id != pointer.instance_id || endpoint.pid != pointer.pid {
    return Err("active Supervisor pointer identity mismatch".to_string());
  }
  if !endpoint_host_is_loopback(&endpoint.host) {
    return Err("active Supervisor endpoint is not loopback".to_string());
  }
  let parsed = url::Url::parse(&endpoint.base_url)
    .map_err(|_| "active Supervisor base URL is invalid".to_string())?;
  if parsed.scheme() != "http"
    || !endpoint_host_is_loopback(parsed.host_str().unwrap_or_default())
    || parsed.port_or_known_default() != Some(endpoint.port)
  {
    return Err("active Supervisor base URL does not match its loopback endpoint".to_string());
  }
  if !process_alive(endpoint.pid) {
    return Err("active Supervisor pid is not running".to_string());
  }
  if endpoint.control_token.len() < 32 {
    return Err("active Supervisor control token is invalid".to_string());
  }
  let snapshot = http_json_with_timeout(
    "GET",
    &format!("{}/v1/status", endpoint.base_url),
    None,
    Some(&endpoint.control_token),
    Duration::from_secs(1),
  )
  .map_err(|error| format!("active Supervisor status unavailable: {error}"))?;
  if snapshot.get("instanceId").and_then(Value::as_str) != Some(endpoint.instance_id.as_str()) {
    return Err("active Supervisor status identity mismatch".to_string());
  }
  let instance_state_dir = endpoint_path
    .parent()
    .map(Path::to_path_buf)
    .ok_or_else(|| "active Supervisor endpoint has no state directory".to_string())?;
  Ok((endpoint, instance_state_dir))
}

fn wait_for_attached_endpoint(
  root_state_dir: &Path,
  pointer_path: &Path,
  timeout: Duration,
) -> Result<(EndpointFile, PathBuf), String> {
  let started = std::time::Instant::now();
  let mut last_error = "active Supervisor is not ready".to_string();
  while started.elapsed() < timeout {
    match read_attached_endpoint(root_state_dir, pointer_path) {
      Ok(endpoint) => return Ok(endpoint),
      Err(error) => last_error = error,
    }
    thread::sleep(Duration::from_millis(200));
  }
  Err(format!("desktop shell could not attach to the active Supervisor: {last_error}"))
}

/// Bind discovery to the Supervisor child this desktop just spawned.
/// A healthy `/health` or last-writer `active-instance.json` is not enough —
/// attaching to a foreign already-running Supervisor is the ownership break.
fn wait_for_spawned_endpoint(
  root_state_dir: &Path,
  pointer_path: &Path,
  spawned_child_pid: u32,
  timeout: Duration,
) -> Result<EndpointFile, String> {
  let started = std::time::Instant::now();
  while started.elapsed() < timeout {
    for endpoint_path in candidate_endpoint_files(root_state_dir, pointer_path) {
      let Ok(endpoint_text) = fs::read_to_string(&endpoint_path) else {
        continue;
      };
      let Ok(endpoint) = serde_json::from_str::<EndpointFile>(&endpoint_text) else {
        continue;
      };
      if !endpoint_host_is_loopback(&endpoint.host) {
        continue;
      }
      if !process_alive(endpoint.pid) {
        continue;
      }
      if !spawned_child_owns_pid(spawned_child_pid, endpoint.pid) {
        continue;
      }
      if endpoint.control_token.len() < 32 {
        continue;
      }
      if http_json_with_timeout(
        "GET",
        &format!("{}/health", endpoint.base_url),
        None,
        None,
        Duration::from_secs(1),
      )
      .is_ok()
      {
        return Ok(endpoint);
      }
    }
    thread::sleep(Duration::from_millis(200));
  }
  Err("desktop supervisor did not publish a control endpoint in time".to_string())
}

fn candidate_endpoint_files(root_state_dir: &Path, pointer_path: &Path) -> Vec<PathBuf> {
  let mut paths = Vec::new();
  if let Ok(text) = fs::read_to_string(pointer_path) {
    if let Ok(pointer) = serde_json::from_str::<ActivePointer>(&text) {
      if !pointer.endpoint_file.is_empty() {
        paths.push(PathBuf::from(pointer.endpoint_file));
      }
    }
  }
  if let Ok(entries) = fs::read_dir(root_state_dir) {
    for entry in entries.flatten() {
      let path = entry.path().join("control-endpoint.json");
      if path.is_file() && !paths.contains(&path) {
        paths.push(path);
      }
    }
  }
  paths
}

fn endpoint_host_is_loopback(host: &str) -> bool {
  host == "127.0.0.1" || host == "localhost" || host == "::1"
}

/// True when `pid` is the spawned child, a member of that child's owned
/// process group, or a descendant in the spawn tree (pnpm/tsx may setpgid
/// after exec; group membership alone is not sufficient).
fn spawned_child_owns_pid(spawned_child_pid: u32, pid: u32) -> bool {
  if spawned_child_pid == 0 || pid == 0 {
    return false;
  }
  if spawned_child_pid == pid {
    return true;
  }
  #[cfg(unix)]
  {
    if unix_pgid(pid) == Some(spawned_child_pid as i32)
      && unix_pgid(spawned_child_pid) == Some(spawned_child_pid as i32)
    {
      return true;
    }
    return unix_is_descendant(spawned_child_pid, pid);
  }
  #[cfg(not(unix))]
  {
    false
  }
}

#[cfg(unix)]
fn unix_is_descendant(ancestor: u32, pid: u32) -> bool {
  let mut current = pid;
  for _ in 0..64 {
    if current == ancestor {
      return true;
    }
    let Some(ppid) = unix_ppid(current) else {
      return false;
    };
    if ppid == 0 || ppid == 1 || ppid == current {
      return false;
    }
    current = ppid;
  }
  false
}

#[cfg(unix)]
fn unix_ppid(pid: u32) -> Option<u32> {
  let text = fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
  let close = text.rfind(')')?;
  let rest = text.get(close + 2..)?;
  let mut parts = rest.split_whitespace();
  let _state = parts.next()?;
  parts.next()?.parse().ok()
}

#[cfg(unix)]
fn unix_pgid(pid: u32) -> Option<i32> {
  let pid = libc::pid_t::try_from(pid).ok()?;
  let pgid = unsafe { libc::getpgid(pid) };
  if pgid > 0 {
    Some(pgid)
  } else {
    None
  }
}

/// Unix spawn bindings: own the descendant process group, and on Linux bind
/// the Supervisor child's lifetime to this desktop via PR_SET_PDEATHSIG.
#[cfg(unix)]
fn bind_supervisor_child_lifetime(command: &mut Command) {
  use std::os::unix::process::CommandExt;
  command.process_group(0);
  #[cfg(target_os = "linux")]
  {
    unsafe {
      command.pre_exec(|| {
        if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM, 0, 0, 0) != 0 {
          return Err(std::io::Error::last_os_error());
        }
        if libc::getppid() == 1 {
          libc::raise(libc::SIGTERM);
        }
        Ok(())
      });
    }
  }
}

/// Loopback JSON over plain TCP — never shell out to PowerShell/curl.
/// PowerShell was flashing console windows on every 5s status poll ("已退出进程").
fn http_json(
  method: &str,
  url: &str,
  body: Option<&str>,
  token: Option<&str>,
) -> Result<Value, String> {
  let timeout = if method.eq_ignore_ascii_case("GET") {
    Duration::from_secs(5)
  } else {
    Duration::from_secs(60)
  };
  http_json_with_timeout(method, url, body, token, timeout)
}

fn http_json_with_timeout(
  method: &str,
  url: &str,
  body: Option<&str>,
  token: Option<&str>,
  read_timeout: Duration,
) -> Result<Value, String> {
  use std::io::{Read, Write};
  use std::net::TcpStream;

  let parsed = url::Url::parse(url).map_err(|e| format!("invalid supervisor url: {e}"))?;
  if parsed.scheme() != "http" {
    return Err("supervisor control plane must use http".into());
  }
  let host = parsed
    .host_str()
    .ok_or_else(|| "supervisor url missing host".to_string())?
    .to_string();
  let host_l = host.to_ascii_lowercase();
  if host_l != "127.0.0.1" && host_l != "localhost" && host_l != "::1" {
    return Err("supervisor HTTP must stay on loopback".into());
  }
  let port = parsed.port().unwrap_or(80);
  let path = {
    let p = parsed.path();
    let path = if p.is_empty() { "/" } else { p };
    match parsed.query() {
      Some(q) => format!("{path}?{q}"),
      None => path.to_string(),
    }
  };

  let is_get = method.eq_ignore_ascii_case("GET");

  // Prefer IPv4 loopback; `localhost` can resolve to ::1 first on some hosts.
  let connect_host = if host_l == "localhost" || host_l == "::1" {
    "127.0.0.1"
  } else {
    host.as_str()
  };
  let mut stream = TcpStream::connect((connect_host, port))
    .map_err(|e| format!("supervisor connect failed: {e}"))?;
  let _ = stream.set_read_timeout(Some(read_timeout));
  let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

  let body_bytes = if is_get {
    None
  } else {
    Some(body.unwrap_or(""))
  };

  let mut request = format!(
    "{method} {path} HTTP/1.1\r\nHost: {host}:{port}\r\nConnection: close\r\nAccept: application/json\r\n"
  );
  if let Some(token) = token {
    // Control tokens are hex; never log them.
    request.push_str("X-Yuvi-Control-Token: ");
    request.push_str(token);
    request.push_str("\r\n");
  }
  if let Some(payload) = body_bytes {
    request.push_str("Content-Type: application/json\r\n");
    request.push_str(&format!("Content-Length: {}\r\n\r\n", payload.len()));
    request.push_str(payload);
  } else {
    request.push_str("\r\n");
  }

  stream
    .write_all(request.as_bytes())
    .map_err(|e| format!("supervisor write failed: {e}"))?;

  let mut raw = Vec::new();
  stream
    .read_to_end(&mut raw)
    .map_err(|e| format!("supervisor read failed: {e}"))?;
  let raw_str = String::from_utf8_lossy(&raw);
  let (header_part, body_part) = raw_str
    .split_once("\r\n\r\n")
    .or_else(|| raw_str.split_once("\n\n"))
    .ok_or_else(|| "invalid HTTP response from supervisor".to_string())?;

  let status_line = header_part.lines().next().unwrap_or("");
  let status_code: u16 = status_line
    .split_whitespace()
    .nth(1)
    .and_then(|s| s.parse().ok())
    .unwrap_or(0);
  if !(200..300).contains(&status_code) {
    return Err(format!("supervisor request failed (HTTP {status_code})"));
  }

  let response_body = if header_part
    .to_ascii_lowercase()
    .contains("transfer-encoding: chunked")
  {
    decode_chunked_body(body_part)?
  } else {
    body_part.to_string()
  };

  let text = response_body.trim();
  if text.is_empty() {
    return Ok(Value::Object(serde_json::Map::new()));
  }
  serde_json::from_str(text).map_err(|e| format!("invalid supervisor JSON: {e}"))
}

fn decode_chunked_body(input: &str) -> Result<String, String> {
  let mut rest = input;
  let mut out = String::new();
  loop {
    let (size_line, after) = rest
      .split_once("\r\n")
      .or_else(|| rest.split_once('\n'))
      .ok_or_else(|| "invalid chunked encoding".to_string())?;
    let size_str = size_line.split(';').next().unwrap_or("").trim();
    let size = usize::from_str_radix(size_str, 16)
      .map_err(|_| format!("invalid chunk size '{size_str}'"))?;
    if size == 0 {
      break;
    }
    if after.len() < size {
      return Err("truncated chunked body".into());
    }
    out.push_str(&after[..size]);
    rest = &after[size..];
    if rest.starts_with("\r\n") {
      rest = &rest[2..];
    } else if rest.starts_with('\n') {
      rest = &rest[1..];
    }
  }
  Ok(out)
}

fn process_alive(pid: u32) -> bool {
  if pid == 0 {
    return false;
  }
  #[cfg(target_os = "windows")]
  {
    // Native OpenProcess — no PowerShell console flash.
    process_alive_windows(pid)
  }
  #[cfg(not(target_os = "windows"))]
  {
    Command::new("kill")
      .args(["-0", &pid.to_string()])
      .status()
      .map(|s| s.success())
      .unwrap_or(false)
  }
}

#[cfg(target_os = "windows")]
fn process_alive_windows(pid: u32) -> bool {
  #[link(name = "kernel32")]
  extern "system" {
    fn OpenProcess(access: u32, inherit: i32, process_id: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    fn GetExitCodeProcess(handle: *mut std::ffi::c_void, exit_code: *mut u32) -> i32;
  }
  const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
  const STILL_ACTIVE: u32 = 259;
  unsafe {
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if handle.is_null() {
      return false;
    }
    let mut code: u32 = 0;
    let ok = GetExitCodeProcess(handle, &mut code);
    CloseHandle(handle);
    ok != 0 && code == STILL_ACTIVE
  }
}

fn resolve_packaged_resource_root(app: &AppHandle) -> Result<PathBuf, String> {
  // Prefer Tauri resource_dir (release install layout).
  if let Ok(resource_dir) = app.path().resource_dir() {
    // Prefer generated/win32-x64 under resource_dir if present (dev staging),
    // else resource_dir itself when it already contains runtime/supervisor.
    let nested = resource_dir.join("generated").join("win32-x64");
    if nested.join("runtime").join("runtime-manifest.json").is_file() {
      return Ok(nested);
    }
    if resource_dir
      .join("runtime")
      .join("runtime-manifest.json")
      .is_file()
    {
      return Ok(resource_dir);
    }
  }
  // Dev-only convenience: resolve crate-local generated/ when force-packaged.
  if let Ok(manifest_dir) = std::env::var("CARGO_MANIFEST_DIR") {
    let generated = PathBuf::from(manifest_dir)
      .join("generated")
      .join("win32-x64");
    if generated
      .join("runtime")
      .join("runtime-manifest.json")
      .is_file()
    {
      return Ok(generated);
    }
  }
  Err(
    "packaging error: Supervisor resource missing (expected runtime/ and supervisor/ under resource dir)"
      .into(),
  )
}

fn which_command(name: &str) -> Option<PathBuf> {
  let path = std::env::var_os("PATH")?;
  for dir in std::env::split_paths(&path) {
    let candidate = dir.join(name);
    if candidate.exists() {
      return Some(candidate);
    }
    let with_exe = dir.join(format!("{name}.exe"));
    if with_exe.exists() {
      return Some(with_exe);
    }
    let with_cmd = dir.join(format!("{name}.cmd"));
    if with_cmd.exists() {
      return Some(with_cmd);
    }
  }
  None
}
