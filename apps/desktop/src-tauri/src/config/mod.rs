pub mod env_export;
mod impact;
mod schema;
pub(crate) mod secrets;
mod service;
mod portable;
mod validate;

#[cfg(test)]
mod tests;

pub use schema::{
    SecretMutationResult, SecretStatus, SettingsChangedEvent, SettingsView, SupervisorSyncStatus,
    UpdateSettingsResult, UserSettingsPatch,
};
pub use secrets::{
    PlatformSecretStore, SecretStore, SECRET_DATABASE_URL, SECRET_DEEPSEEK_API_KEY,
    SECRET_MEMORY_LLM_API_KEY, SECRET_OPENAI_COMPATIBLE_API_KEY,
};
pub use service::ConfigService;
pub(crate) use schema::MemoryBackend;

use crate::desktop_surface::DesktopSurfaceManager;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, State};

pub struct ConfigState {
    pub service: Arc<ConfigService>,
    pub(crate) boot: std::sync::Mutex<()>,
}

impl ConfigState {
    pub fn new(service: Arc<ConfigService>) -> Self {
        Self { service, boot: std::sync::Mutex::new(()) }
    }
}

pub fn init_config_service(app: &AppHandle) -> Result<Arc<ConfigService>, String> {
    let config_dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir unavailable: {e}"))?;
    let secrets: Arc<dyn SecretStore> = Arc::new(PlatformSecretStore);
    let portable = match std::env::var("YUVI_PORTABLE_VERSION") {
        Ok(version) if version == env!("CARGO_PKG_VERSION") => true,
        Ok(_) => return Err("Portable release identity mismatch".into()),
        Err(_) => false,
    };
    let service = Arc::new(ConfigService::open_with_profile(config_dir, secrets, portable));
    Ok(service)
}

#[tauri::command]
pub fn get_user_settings(state: State<'_, ConfigState>) -> Result<SettingsView, String> {
    state.service.get_view()
}

#[tauri::command]
pub async fn update_user_settings(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, ConfigState>,
    patch: UserSettingsPatch,
) -> Result<UpdateSettingsResult, String> {
    crate::native_product::confirm_control(&window, "允许修改此本机 YUVI 的设置并按需重启服务？")?;
    let before = state.service.current_settings()?;
    let mut result = state.service.update_settings(patch)?;
    let event =
        state
            .service
            .changed_event(&before, &result.settings, result.restart_services.clone());
    let _ = app.emit("settings.changed", &event);

    // Apply companion always-on-top immediately when changed. Presentation
    // behavior belongs to the desktop surface seam.
    if before.companion.always_on_top != result.settings.companion.always_on_top {
        DesktopSurfaceManager::apply_companion_always_on_top(
            &app,
            result.settings.companion.always_on_top,
        );
    }

    // Persistence already succeeded; supervisor sync is best-effort and reported.
    result.supervisor_sync = push_supervisor_config(&app, &state);
    Ok(result)
}

#[tauri::command]
pub async fn set_user_secret(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, ConfigState>,
    key: String,
    value: String,
) -> Result<SecretMutationResult, String> {
    crate::native_product::confirm_control(&window, "允许为此本机 YUVI 更新所选服务凭据？")?;
    let secrets = state.service.set_secret(&key, &value)?;
    let restart_services = secret_restart_hint(&key);
    let _ = app.emit(
        "settings.changed",
        SettingsChangedEvent {
            revision: state.service.revision(),
            changed_sections: vec!["secrets".into()],
            restart_services: restart_services.clone(),
        },
    );
    let supervisor_sync = push_supervisor_config(&app, &state);
    Ok(SecretMutationResult {
        saved: true,
        secrets,
        restart_services,
        supervisor_sync,
    })
}

#[tauri::command]
pub async fn delete_user_secret(
    window: tauri::WebviewWindow,
    app: AppHandle,
    state: State<'_, ConfigState>,
    key: String,
) -> Result<SecretMutationResult, String> {
    crate::native_product::confirm_control(&window, "允许删除此本机 YUVI 的所选服务凭据？")?;
    let secrets = state.service.delete_secret(&key)?;
    let restart_services = secret_restart_hint(&key);
    let _ = app.emit(
        "settings.changed",
        SettingsChangedEvent {
            revision: state.service.revision(),
            changed_sections: vec!["secrets".into()],
            restart_services: restart_services.clone(),
        },
    );
    let supervisor_sync = push_supervisor_config(&app, &state);
    Ok(SecretMutationResult {
        saved: true,
        secrets,
        restart_services,
        supervisor_sync,
    })
}

/// Best-effort live config sync. Settings page works even if Supervisor is down.
/// Returns applied status; never fails the caller's save path.
fn push_supervisor_config(app: &AppHandle, state: &State<'_, ConfigState>) -> SupervisorSyncStatus {
    match state.service.supervisor_config_push() {
        Ok(payload) => match crate::supervisor::push_runtime_config(app, &payload) {
            Ok(_) => SupervisorSyncStatus::applied_ok(),
            Err(error) => {
                // Do not log payload (may contain secrets). Redact error text.
                let status = SupervisorSyncStatus::failed(error);
                eprintln!(
                    "[yuvi-desktop] supervisor config push skipped: {}",
                    status.error.as_deref().unwrap_or("unknown")
                );
                status
            }
        },
        Err(error) => {
            let status = SupervisorSyncStatus::failed(error);
            eprintln!(
                "[yuvi-desktop] supervisor config build failed: {}",
                status.error.as_deref().unwrap_or("unknown")
            );
            status
        }
    }
}

#[tauri::command]
pub fn get_user_secret_status(state: State<'_, ConfigState>) -> Result<SecretStatus, String> {
    state.service.secret_status()
}

fn secret_restart_hint(key: &str) -> Vec<String> {
    match key {
        SECRET_DEEPSEEK_API_KEY | SECRET_OPENAI_COMPATIBLE_API_KEY => vec!["runtime".into()],
        SECRET_DATABASE_URL => vec!["memory".into(), "runtime".into()],
        SECRET_MEMORY_LLM_API_KEY => vec!["memory".into()],
        _ => Vec::new(),
    }
}
