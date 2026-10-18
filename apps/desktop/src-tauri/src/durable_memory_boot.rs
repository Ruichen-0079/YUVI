use std::thread;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::config::{env_export::SupervisorConfigPush, ConfigState};
use crate::supervisor::{self, SupervisorState};

const POSTGRES_TIMEOUT: Duration = Duration::from_secs(35);
const MEM0_TIMEOUT: Duration = Duration::from_secs(90);
const RUNTIME_TIMEOUT: Duration = Duration::from_secs(45);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Linux packaged attach boot. This sequences the existing DesktopSupervisor
/// authority; it never starts a second lifecycle owner or persists a DATABASE_URL.
pub(crate) fn bootstrap_attached_linux(app: &AppHandle) -> Result<(), String> {
  let state = app.state::<ConfigState>();
  let _boot = state
    .boot
    .lock()
    .map_err(|_| "Product boot lock unavailable")?;
  let full = {
    let config = app.state::<ConfigState>();
    config
      .service
      .ensure_private_postgres_password()
      .map_err(|error| format!("private PostgreSQL secret persist failed: {error}"))?;
    config.service.supervisor_config_push()?
  };

  let revision = state.service.revision();
  let wants_mem0 = env_flag(&full, "YUVI_AUTOSTART_MEM0");
  let wants_runtime = env_flag(&full, "YUVI_AUTOSTART_RUNTIME");

  let wants_private_r5 = private_r5_required(&full);

  if wants_mem0 || wants_private_r5 {
    // Stage 1: inject the platform-secret-backed cluster credential while
    // Runtime and Mem0 remain stopped, then make the owned private PG ready.
    let postgres_stage = staged_payload(&full, false, false, true);
    boot_current(app, revision)?;
    supervisor::push_runtime_config(app, &postgres_stage)?;
    start_service(app, "postgres")?;
    wait_for_service(
      app,
      "postgres",
      POSTGRES_TIMEOUT,
      revision,
      |status, ownership| status == "healthy" && ownership == "owned",
    )?;

    // Stage 2: the packaged Mem0 wrapper runs the existing Runtime migration
    // authority before exec'ing Mem0. Operational Mem0 therefore implies PG
    // readiness + migrations; optional inference may truthfully remain degraded.
    if wants_mem0 {
      let mem0_stage = staged_payload(&full, false, true, true);
      boot_current(app, revision)?;
      supervisor::push_runtime_config(app, &mem0_stage)?;
      start_service(app, "mem0")?;
      wait_for_service(app, "mem0", MEM0_TIMEOUT, revision, |status, ownership| {
        matches!(status, "healthy" | "degraded") && ownership == "owned"
      })?;
    }
  }

  // Restore Product settings as the final authority. Managed Mem0 keeps the
  // private-PG selection; legacy/external Memory is not silently converted.
  let final_payload = if wants_mem0 || wants_private_r5 {
    staged_payload(&full, wants_runtime, wants_mem0, true)
  } else {
    full
  };
  boot_current(app, revision)?;
  supervisor::push_runtime_config(app, &final_payload)?;
  if wants_runtime {
    start_service(app, "runtime")?;
    wait_for_service(
      app,
      "runtime",
      RUNTIME_TIMEOUT,
      revision,
      |status, ownership| status == "healthy" && ownership == "owned",
    )?;
  }
  Ok(())
}

fn private_r5_required(full: &SupervisorConfigPush) -> bool {
  env_flag(full, "YUVI_AUTOSTART_RUNTIME")
    && full
      .env
      .get("MEMORY_BACKEND")
      .is_some_and(|backend| backend == "postgres")
    && !full
      .env
      .get("DATABASE_URL")
      .is_some_and(|url| !url.trim().is_empty())
}

fn boot_current(app: &AppHandle, revision: u64) -> Result<(), String> {
  if app.state::<ConfigState>().service.revision() != revision {
    return Err("Product boot superseded by newer user settings".into());
  }
  Ok(())
}

fn staged_payload(
  source: &SupervisorConfigPush,
  runtime_autostart: bool,
  mem0_autostart: bool,
  private_postgres: bool,
) -> SupervisorConfigPush {
  let mut payload = source.clone();
  set_env_flag(&mut payload, "YUVI_AUTOSTART_RUNTIME", runtime_autostart);
  set_env_flag(&mut payload, "YUVI_AUTOSTART_MEM0", mem0_autostart);
  if private_postgres {
    payload
      .env
      .insert("YUVI_POSTGRES_MODE".into(), "private".into());
    payload.unset_env.retain(|key| key != "YUVI_POSTGRES_MODE");
  }
  payload
}

fn set_env_flag(payload: &mut SupervisorConfigPush, key: &str, value: bool) {
  payload
    .env
    .insert(key.to_string(), if value { "true" } else { "false" }.into());
  payload.unset_env.retain(|item| item != key);
}

fn env_flag(payload: &SupervisorConfigPush, key: &str) -> bool {
  payload
    .env
    .get(key)
    .map(|value| {
      matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
      )
    })
    .unwrap_or(false)
}

fn start_service(app: &AppHandle, service_id: &str) -> Result<(), String> {
  let state = app.state::<SupervisorState>();
  supervisor::service_action_owned(state, "start".into(), service_id.into()).map(|_| ())
}

fn service_state(snapshot: &Value, service_id: &str) -> Option<(String, String)> {
  let service = snapshot
    .get("services")?
    .as_array()?
    .iter()
    .find(|service| service.get("id").and_then(Value::as_str) == Some(service_id))?;
  Some((
    service.get("status")?.as_str()?.to_string(),
    service.get("ownership")?.as_str()?.to_string(),
  ))
}

fn wait_for_service<F>(
  app: &AppHandle,
  service_id: &str,
  timeout: Duration,
  revision: u64,
  ready: F,
) -> Result<(), String>
where
  F: Fn(&str, &str) -> bool,
{
  let deadline = Instant::now() + timeout;
  let mut last = "unknown/unknown".to_string();
  loop {
    boot_current(app, revision)?;
    let snapshot = supervisor::get_service_status(app.state::<SupervisorState>())?;
    if let Some((status, ownership)) = service_state(&snapshot, service_id) {
      last = format!("{status}/{ownership}");
      if ready(&status, &ownership) {
        return Ok(());
      }
      if status == "unavailable" {
        return Err(format!("{service_id} became unavailable ({last})"));
      }
    }
    if Instant::now() >= deadline {
      return Err(format!("timed out waiting for {service_id} ({last})"));
    }
    thread::sleep(POLL_INTERVAL);
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::collections::BTreeMap;

  fn payload() -> SupervisorConfigPush {
    SupervisorConfigPush {
      env: BTreeMap::from([
        ("YUVI_AUTOSTART_RUNTIME".into(), "true".into()),
        ("YUVI_AUTOSTART_MEM0".into(), "true".into()),
        ("MEMORY_BACKEND".into(), "mem0".into()),
        ("YUVI_POSTGRES_PASSWORD".into(), "never-log-this".into()),
      ]),
      unset_env: vec!["YUVI_POSTGRES_MODE".into()],
    }
  }

  #[test]
  fn r5_boot_uses_owned_postgres_only_when_no_explicit_database_is_configured() {
    let mut payload = payload();
    payload
      .env
      .insert("MEMORY_BACKEND".into(), "postgres".into());
    payload
      .env
      .insert("YUVI_AUTOSTART_RUNTIME".into(), "true".into());
    payload.env.remove("DATABASE_URL");
    assert!(private_r5_required(&payload));
    payload.env.insert(
      "DATABASE_URL".into(),
      "postgres://synthetic-explicit-test".into(),
    );
    assert!(!private_r5_required(&payload));
    payload.env.remove("DATABASE_URL");
    payload.env.insert("MEMORY_BACKEND".into(), "mem0".into());
    assert!(!private_r5_required(&payload));
  }

  #[test]
  fn a9_stages_postgres_then_mem0_without_losing_secret_payload() {
    let source = payload();
    let pg = staged_payload(&source, false, false, true);
    assert_eq!(
      pg.env.get("YUVI_AUTOSTART_RUNTIME").map(String::as_str),
      Some("false")
    );
    assert_eq!(
      pg.env.get("YUVI_AUTOSTART_MEM0").map(String::as_str),
      Some("false")
    );
    assert_eq!(
      pg.env.get("YUVI_POSTGRES_MODE").map(String::as_str),
      Some("private")
    );
    assert_eq!(
      pg.env.get("YUVI_POSTGRES_PASSWORD").map(String::as_str),
      Some("never-log-this")
    );
    assert!(!pg.unset_env.iter().any(|key| key == "YUVI_POSTGRES_MODE"));

    let mem0 = staged_payload(&source, false, true, true);
    assert_eq!(
      mem0.env.get("YUVI_AUTOSTART_RUNTIME").map(String::as_str),
      Some("false")
    );
    assert_eq!(
      mem0.env.get("YUVI_AUTOSTART_MEM0").map(String::as_str),
      Some("true")
    );
  }

  #[test]
  fn operational_gate_accepts_optional_llm_degraded_mem0() {
    let snapshot: Value = serde_json::json!({
      "services": [
        { "id": "postgres", "status": "healthy", "ownership": "owned" },
        { "id": "mem0", "status": "degraded", "ownership": "owned" },
        { "id": "runtime", "status": "stopped", "ownership": "none" }
      ]
    });
    assert_eq!(
      service_state(&snapshot, "mem0"),
      Some(("degraded".into(), "owned".into()))
    );
    assert!(env_flag(&payload(), "YUVI_AUTOSTART_MEM0"));
  }
}
