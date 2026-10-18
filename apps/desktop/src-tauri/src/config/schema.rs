//! User settings schema v1. No secrets in this structure.

use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettings {
    pub schema_version: u32,
    pub app: AppSettings,
    pub chat: ChatSettings,
    #[serde(default)]
    pub cognition: CognitionSettings,
    #[serde(default)]
    pub openai_compatible: OpenAiCompatibleSettings,
    pub runtime: RuntimeSettings,
    pub memory: MemorySettings,
    pub tts: TtsSettings,
    #[serde(default)]
    pub stt: SttSettings,
    pub companion: CompanionSettings,
    #[serde(default)]
    pub proactive: ProactiveSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub language: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettings {
    pub provider: String,
    pub model: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CognitionSettings {
    pub provider: String,
    pub model: String,
}

impl Default for CognitionSettings {
    fn default() -> Self {
        Self {
            provider: "openai-compatible".into(),
            model: "zai-org/GLM-5.3-Flash".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenAiCompatibleSettings {
    pub base_url: String,
}

impl Default for OpenAiCompatibleSettings {
    fn default() -> Self {
        Self {
            base_url: "https://api.deepinfra.com/v1/openai".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettings {
    pub mode: ServiceMode,
    pub autostart: bool,
    pub url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySettings {
    pub enabled: bool,
    pub backend: MemoryBackend,
    pub mode: ServiceMode,
    pub base_url: String,
    pub subject_user_id: String,
    pub persona_id: String,
    pub ollama_url: String,
    #[serde(default)]
    pub llm: MemoryLlmSettings,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryLlmSettings {
    pub provider: MemoryLlmProvider,
    pub model: String,
    pub base_url: String,
}

impl Default for MemoryLlmSettings {
    fn default() -> Self {
        Self {
            provider: MemoryLlmProvider::None,
            model: String::new(),
            base_url: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSettings {
    pub enabled: bool,
    pub mode: ServiceMode,
    pub wrapper_url: String,
    pub upstream_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SttSettings {
    pub provider: SttProvider,
    pub mode: ServiceMode,
    pub autostart: bool,
    pub base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SttProvider {
    Local,
    Dashscope,
}

impl Default for SttSettings {
    fn default() -> Self {
        Self {
            provider: SttProvider::Dashscope,
            mode: ServiceMode::External,
            autostart: false,
            base_url: "http://127.0.0.1:9876".into(),
            model: "sense-voice-zh-en-ja-ko-yue-2024-07-17-int8".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSettings {
    pub always_on_top: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProactiveSettings {
    pub enabled: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ServiceMode {
    Managed,
    External,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryBackend {
    Postgres,
    Mem0,
    Legacy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MemoryLlmProvider {
    None,
    Deepseek,
    Openai,
}

impl Default for UserSettings {
    fn default() -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            app: AppSettings {
                language: "zh-CN".into(),
            },
            chat: ChatSettings {
                provider: "openai-compatible".into(),
                model: "deepseek-ai/DeepSeek-V4-Flash-0731".into(),
            },
            cognition: CognitionSettings::default(),
            openai_compatible: OpenAiCompatibleSettings::default(),
            runtime: RuntimeSettings {
                mode: ServiceMode::Managed,
                autostart: true,
                url: "http://127.0.0.1:6121".into(),
            },
            memory: MemorySettings {
                enabled: true,
                backend: MemoryBackend::Mem0,
                mode: ServiceMode::Managed,
                base_url: "http://127.0.0.1:6131".into(),
                subject_user_id: "local-owner".into(),
                persona_id: "alice".into(),
                ollama_url: "http://127.0.0.1:11434".into(),
                llm: MemoryLlmSettings::default(),
            },
            tts: TtsSettings {
                // GPT-SoVITS/Alice is not a distributable packaged artifact.
                // Keep fresh installs truthful until an external service is
                // explicitly configured by the user.
                enabled: false,
                mode: ServiceMode::External,
                wrapper_url: "http://127.0.0.1:9881".into(),
                upstream_url: "http://127.0.0.1:9880".into(),
            },
            stt: SttSettings::default(),
            companion: CompanionSettings {
                always_on_top: true,
            },
            proactive: ProactiveSettings::default(),
        }
    }
}

/// Partial patch from the frontend. All fields optional.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSettingsPatch {
    pub app: Option<AppSettingsPatch>,
    pub chat: Option<ChatSettingsPatch>,
    pub cognition: Option<CognitionSettingsPatch>,
    pub openai_compatible: Option<OpenAiCompatibleSettingsPatch>,
    pub runtime: Option<RuntimeSettingsPatch>,
    pub memory: Option<MemorySettingsPatch>,
    pub tts: Option<TtsSettingsPatch>,
    pub stt: Option<SttSettingsPatch>,
    pub companion: Option<CompanionSettingsPatch>,
    pub proactive: Option<ProactiveSettingsPatch>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettingsPatch {
    pub language: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSettingsPatch {
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CognitionSettingsPatch {
    pub provider: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenAiCompatibleSettingsPatch {
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSettingsPatch {
    pub mode: Option<ServiceMode>,
    pub autostart: Option<bool>,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySettingsPatch {
    pub enabled: Option<bool>,
    pub backend: Option<MemoryBackend>,
    pub mode: Option<ServiceMode>,
    pub base_url: Option<String>,
    pub subject_user_id: Option<String>,
    pub persona_id: Option<String>,
    pub ollama_url: Option<String>,
    pub llm: Option<MemoryLlmSettingsPatch>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryLlmSettingsPatch {
    pub provider: Option<MemoryLlmProvider>,
    pub model: Option<String>,
    pub base_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TtsSettingsPatch {
    pub enabled: Option<bool>,
    pub mode: Option<ServiceMode>,
    pub wrapper_url: Option<String>,
    pub upstream_url: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SttSettingsPatch {
    pub provider: Option<SttProvider>,
    pub mode: Option<ServiceMode>,
    pub autostart: Option<bool>,
    pub base_url: Option<String>,
    pub model: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSettingsPatch {
    pub always_on_top: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProactiveSettingsPatch {
    pub enabled: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretStatus {
    pub deepseek_api_key: bool,
    pub openai_compatible_api_key: bool,
    pub database_url: bool,
    pub memory_llm_api_key: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub settings: UserSettings,
    pub secrets: SecretStatus,
    pub revision: u64,
    pub config_path: String,
    pub load_error: Option<String>,
}

/// Outcome of best-effort live Supervisor config push after a successful save.
/// `saved` remains true even when `applied` is false.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorSyncStatus {
    pub applied: bool,
    /// Short redacted error; never endpoints, tokens, secrets, or stack traces.
    pub error: Option<String>,
}

impl SupervisorSyncStatus {
    pub fn applied_ok() -> Self {
        Self {
            applied: true,
            error: None,
        }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self {
            applied: false,
            error: Some(redact_supervisor_error(&message.into())),
        }
    }
}

/// Strip secrets / tokens / long stack dumps from supervisor error text.
pub fn redact_supervisor_error(raw: &str) -> String {
    let first_line = raw.lines().next().unwrap_or(raw).trim();
    let mut out = first_line.to_string();
    // Drop obvious credential material if an error string ever embeds it.
    if out.len() > 160 {
        out.truncate(160);
        out.push('…');
    }
    // Never return Authorization / bearer / long hex tokens.
    let lower = out.to_lowercase();
    if lower.contains("bearer ")
        || lower.contains("authorization")
        || lower.contains("control_token")
        || lower.contains("controltoken")
    {
        return "Supervisor sync failed".into();
    }
    // Collapse connection-style errors to a short stable message.
    if lower.contains("not running")
        || lower.contains("connection refused")
        || lower.contains("timed out")
        || lower.contains("failed to connect")
        || lower.contains("os error 10061")
    {
        return "Supervisor unavailable".into();
    }
    if out.is_empty() {
        return "Supervisor sync failed".into();
    }
    out
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSettingsResult {
    pub saved: bool,
    pub restart_services: Vec<String>,
    pub restart_application: bool,
    pub revision: u64,
    pub settings: UserSettings,
    pub secrets: SecretStatus,
    pub supervisor_sync: SupervisorSyncStatus,
}

/// Result of set/delete secret: persistence success + optional supervisor sync.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SecretMutationResult {
    pub saved: bool,
    pub secrets: SecretStatus,
    pub restart_services: Vec<String>,
    pub supervisor_sync: SupervisorSyncStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsChangedEvent {
    pub revision: u64,
    pub changed_sections: Vec<String>,
    pub restart_services: Vec<String>,
}
