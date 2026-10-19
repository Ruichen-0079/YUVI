//! ConfigService: sole authority for user settings on disk + secret status.

use super::env_export::combined_env_for_supervisor;
use super::impact::{compute_restart_services, restart_application_needed};
use super::schema::{
    SecretStatus, SettingsChangedEvent, SettingsView, SupervisorSyncStatus, UpdateSettingsResult,
    UserSettings, UserSettingsPatch, SCHEMA_VERSION,
};
use super::secrets::{
    SecretStore, SECRET_DATABASE_URL, SECRET_DEEPSEEK_API_KEY, SECRET_MEMORY_LLM_API_KEY,
    SECRET_OPENAI_COMPATIBLE_API_KEY, SECRET_POSTGRES_LOCAL_PASSWORD,
};
use super::validate::{apply_patch, validate_settings};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct ConfigService {
    portable: bool,
    settings_path: PathBuf,
    secrets: Arc<dyn SecretStore>,
    settings: Mutex<UserSettings>,
    load_error: Mutex<Option<String>>,
    revision: AtomicU64,
}

impl ConfigService {
    pub fn open(config_dir: PathBuf, secrets: Arc<dyn SecretStore>) -> Self {
        Self::open_with_profile(config_dir, secrets, false)
    }

    pub fn open_with_profile(config_dir: PathBuf, secrets: Arc<dyn SecretStore>, portable: bool) -> Self {
        fs::create_dir_all(&config_dir).ok();
        let settings_path = config_dir.join("settings.json");
        let (mut settings, load_error) = load_or_default(&settings_path, &config_dir);
        if !settings_path.exists() && std::env::var("YUVI_PACKAGE_PROFILE").as_deref() == Ok("r5") {
            // The R5-only distribution has no legacy Mem0 sidecar. Keep first
            // run inactive until the native activation ceremony explicitly opts in.
            settings.memory.backend = super::schema::MemoryBackend::Legacy;
        }
        if portable {
            // Release transport addresses are fixed by the Portable launcher.
            // Rebase old/default addresses without replacing Product preferences.
            super::portable::rebase_endpoints(&mut settings);
        }
        Self {
            portable,
            settings_path,
            secrets,
            settings: Mutex::new(settings),
            load_error: Mutex::new(load_error),
            revision: AtomicU64::new(1),
        }
    }

    #[cfg(test)]
    pub fn settings_path(&self) -> &Path {
        &self.settings_path
    }

    pub fn revision(&self) -> u64 {
        self.revision.load(Ordering::SeqCst)
    }

    pub fn get_view(&self) -> Result<SettingsView, String> {
        let settings = self
            .settings
            .lock()
            .map_err(|_| "config lock poisoned".to_string())?
            .clone();
        let secrets = self.secret_status()?;
        let load_error = self
            .load_error
            .lock()
            .map_err(|_| "config lock poisoned".to_string())?
            .clone();
        Ok(SettingsView {
            settings,
            secrets,
            revision: self.revision(),
            config_path: self.settings_path.display().to_string(),
            load_error,
        })
    }

    pub fn update_settings(
        &self,
        patch: UserSettingsPatch,
    ) -> Result<UpdateSettingsResult, String> {
        let mut guard = self
            .settings
            .lock()
            .map_err(|_| "config lock poisoned".to_string())?;
        let before = guard.clone();
        let after = apply_patch(&before, &patch)?;
        if self.portable {
            super::portable::validate(&after)?;
        }
        atomic_write_json(&self.settings_path, &after)?;
        *guard = after.clone();
        drop(guard);

        if let Ok(mut err) = self.load_error.lock() {
            *err = None;
        }

        let revision = self.revision.fetch_add(1, Ordering::SeqCst) + 1;
        let restart_services = compute_restart_services(&before, &after);
        let restart_application = restart_application_needed(&before, &after);
        let secrets = self.secret_status()?;

        Ok(UpdateSettingsResult {
            saved: true,
            restart_services,
            restart_application,
            revision,
            settings: after,
            secrets,
            // Filled by the Tauri command after best-effort Supervisor push.
            supervisor_sync: SupervisorSyncStatus::applied_ok(),
        })
    }

    pub fn set_secret(&self, key: &str, value: &str) -> Result<SecretStatus, String> {
        validate_user_secret_key(key)?;
        self.secrets.set(key, value)?;
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.secret_status()
    }

    pub fn delete_secret(&self, key: &str) -> Result<SecretStatus, String> {
        validate_user_secret_key(key)?;
        self.secrets.delete(key)?;
        self.revision.fetch_add(1, Ordering::SeqCst);
        self.secret_status()
    }

    /// Internal bootstrap only. Not exposed as a user-editable settings secret.
    pub fn ensure_private_postgres_password(&self) -> Result<String, String> {
        if let Some(existing) = self.secrets.get(SECRET_POSTGRES_LOCAL_PASSWORD)? {
            if !existing.trim().is_empty() {
                return Ok(existing);
            }
        }
        let generated = super::secrets::generate_postgres_password()?;
        self.secrets
            .set(SECRET_POSTGRES_LOCAL_PASSWORD, &generated)?;
        self.revision.fetch_add(1, Ordering::SeqCst);
        Ok(generated)
    }

    pub fn secret_status(&self) -> Result<SecretStatus, String> {
        Ok(SecretStatus {
            deepseek_api_key: self.secrets.is_configured(SECRET_DEEPSEEK_API_KEY)?,
            openai_compatible_api_key: self
                .secrets
                .is_configured(SECRET_OPENAI_COMPATIBLE_API_KEY)?,
            database_url: self.secrets.is_configured(SECRET_DATABASE_URL)?,
            memory_llm_api_key: self.secrets.is_configured(SECRET_MEMORY_LLM_API_KEY)?,
        })
    }

    pub fn current_settings(&self) -> Result<UserSettings, String> {
        self.settings
            .lock()
            .map_err(|_| "config lock poisoned".to_string())
            .map(|g| g.clone())
    }

    pub fn supervisor_env(&self) -> Result<BTreeMap<String, String>, String> {
        let settings = self.current_settings()?;
        if self.portable { super::portable::validate(&settings)?; }
        combined_env_for_supervisor(&settings, self.secrets.as_ref())
    }

    /// Full push payload for live Supervisor config refresh (includes secret env + unsets).
    pub fn supervisor_config_push(
        &self,
    ) -> Result<super::env_export::SupervisorConfigPush, String> {
        let settings = self.current_settings()?;
        if self.portable { super::portable::validate(&settings)?; }
        super::env_export::supervisor_config_push(&settings, self.secrets.as_ref())
    }

    pub fn changed_event(
        &self,
        before: &UserSettings,
        after: &UserSettings,
        restart_services: Vec<String>,
    ) -> SettingsChangedEvent {
        SettingsChangedEvent {
            revision: self.revision(),
            changed_sections: changed_sections(before, after),
            restart_services,
        }
    }
}

fn validate_user_secret_key(key: &str) -> Result<(), String> {
    match key {
        SECRET_DEEPSEEK_API_KEY
        | SECRET_OPENAI_COMPATIBLE_API_KEY
        | SECRET_DATABASE_URL
        | SECRET_MEMORY_LLM_API_KEY => Ok(()),
        SECRET_POSTGRES_LOCAL_PASSWORD => Err(
            "postgres.localPassword is an internal infrastructure secret and is not user-editable"
                .into(),
        ),
        other => Err(format!("unsupported secret key: {other}")),
    }
}

fn load_or_default(path: &Path, config_dir: &Path) -> (UserSettings, Option<String>) {
    if !path.exists() {
        return (UserSettings::default(), None);
    }
    match fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<UserSettings>(&text) {
            Ok(parsed) => match validate_settings(&parsed) {
                Ok(()) => (parsed, None),
                Err(error) => {
                    quarantine_invalid(config_dir, path, &text);
                    (UserSettings::default(), Some(error))
                }
            },
            Err(error) => {
                quarantine_invalid(config_dir, path, &text);
                (
                    UserSettings::default(),
                    Some(format!("settings.json is invalid: {error}")),
                )
            }
        },
        Err(error) => (
            UserSettings::default(),
            Some(format!("failed to read settings.json: {error}")),
        ),
    }
}

fn quarantine_invalid(config_dir: &Path, path: &Path, text: &str) {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let backup = config_dir.join(format!("settings.invalid-{ts}.json"));
    let _ = fs::write(&backup, text);
    let _ = fs::remove_file(path);
}

/// Atomic replace: write tmp (same dir) → flush/sync → replace target.
/// Never deletes the live target before the replace succeeds.
/// - Windows: MoveFileExW(MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)
/// - Other: same-directory rename (POSIX atomic replace when dest exists)
pub fn atomic_write_json(path: &Path, value: &UserSettings) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!("settings.{ts}.json.tmp"));
    let payload = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    {
        use std::io::Write;
        let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(format!("{payload}\n").as_bytes())
            .map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        file.sync_all().ok();
    }

    if let Err(error) = replace_file(&tmp, path) {
        // Preserve original settings.json; clean failed tmp best-effort.
        let _ = fs::remove_file(&tmp);
        return Err(error);
    }
    // No leftover tmp next to settings.json.
    if tmp.exists() {
        let _ = fs::remove_file(&tmp);
    }
    let _ = SCHEMA_VERSION;
    Ok(())
}

/// Replace `target` with `tmp`. Does not delete `target` first.
/// On failure the original `target` (if any) remains untouched.
pub fn replace_file(tmp: &Path, target: &Path) -> Result<(), String> {
    if !tmp.exists() {
        return Err("atomic replace source tmp is missing".into());
    }
    if !target.exists() {
        // Destination absent: plain rename is atomic create.
        return fs::rename(tmp, target).map_err(|e| e.to_string());
    }

    #[cfg(windows)]
    {
        win_atomic_replace(tmp, target)
    }

    #[cfg(not(windows))]
    {
        // Same-directory rename replaces atomically on POSIX.
        fs::rename(tmp, target).map_err(|e| e.to_string())
    }
}

#[cfg(windows)]
fn win_atomic_replace(tmp: &Path, target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;

    type Bool = i32;
    type Dword = u32;

    const MOVEFILE_REPLACE_EXISTING: Dword = 0x1;
    const MOVEFILE_WRITE_THROUGH: Dword = 0x8;

    #[link(name = "kernel32")]
    extern "system" {
        fn MoveFileExW(
            lp_existing_file_name: *const u16,
            lp_new_file_name: *const u16,
            dw_flags: Dword,
        ) -> Bool;
        fn GetLastError() -> Dword;
    }

    fn to_wide(path: &Path) -> Vec<u16> {
        path.as_os_str().encode_wide().chain(Some(0)).collect()
    }

    let from = to_wide(tmp);
    let to = to_wide(target);
    // lpExistingFileName = source (tmp), lpNewFileName = destination (target).
    let ok = unsafe {
        MoveFileExW(
            from.as_ptr(),
            to.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if ok == 0 {
        let code = unsafe { GetLastError() };
        return Err(format!(
            "MoveFileExW atomic replace failed (Win32 error {code})"
        ));
    }
    Ok(())
}

fn changed_sections(before: &UserSettings, after: &UserSettings) -> Vec<String> {
    let mut sections = Vec::new();
    if before.app != after.app {
        sections.push("app".into());
    }
    if before.chat != after.chat {
        sections.push("chat".into());
    }
    if before.cognition != after.cognition {
        sections.push("cognition".into());
    }
    if before.openai_compatible != after.openai_compatible {
        sections.push("openaiCompatible".into());
    }
    if before.runtime != after.runtime {
        sections.push("runtime".into());
    }
    if before.memory != after.memory {
        sections.push("memory".into());
    }
    if before.tts != after.tts {
        sections.push("tts".into());
    }
    if before.stt != after.stt {
        sections.push("stt".into());
    }
    if before.companion != after.companion {
        sections.push("companion".into());
    }
    if before.proactive != after.proactive {
        sections.push("proactive".into());
    }
    sections
}
