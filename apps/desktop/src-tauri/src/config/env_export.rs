//! Build env overrides for the desktop supervisor / managed child processes.
//! Never puts secrets into logs or command-line arguments.

use super::schema::{MemoryBackend, MemoryLlmProvider, ServiceMode, SttProvider, UserSettings};
use super::secrets::{
    SecretStore, SECRET_DATABASE_URL, SECRET_DEEPSEEK_API_KEY, SECRET_MEMORY_LLM_API_KEY,
    SECRET_OPENAI_COMPATIBLE_API_KEY, SECRET_POSTGRES_LOCAL_PASSWORD,
};
use serde::Serialize;
use std::collections::BTreeMap;

/// Public (non-secret) env overrides derived from user settings.
pub fn public_env_overrides(settings: &UserSettings) -> BTreeMap<String, String> {
    let mut env = BTreeMap::new();

    env.insert(
        "YUVI_AUTOSTART_RUNTIME".into(),
        bool_flag(settings.runtime.autostart && settings.runtime.mode == ServiceMode::Managed),
    );
    env.insert(
        "YUVI_AUTOSTART_MEM0".into(),
        bool_flag(
            settings.memory.enabled
                && settings.memory.mode == ServiceMode::Managed
                && matches!(settings.memory.backend, MemoryBackend::Mem0),
        ),
    );
    env.insert(
        "YUVI_AUTOSTART_TTS".into(),
        bool_flag(settings.tts.enabled && settings.tts.mode == ServiceMode::Managed),
    );

    // Runtime URL → host/port when possible.
    if let Some((host, port)) = split_http_host_port(&settings.runtime.url) {
        env.insert("SERVER_HOST".into(), host);
        env.insert("SERVER_PORT".into(), port);
    }

    env.insert("DEFAULT_CHAT_PROVIDER".into(), settings.chat.provider.clone());
    env.insert("CHAT_PROVIDER_CHAIN".into(), settings.chat.provider.clone());
    env.insert(
        "DEFAULT_REASONING_PROVIDER".into(),
        settings.cognition.provider.clone(),
    );
    env.insert(
        "REASONING_PROVIDER_CHAIN".into(),
        settings.cognition.provider.clone(),
    );
    if uses_openai_compatible(settings) {
        env.insert(
            "OPENAI_COMPATIBLE_API_BASEURL".into(),
            settings.openai_compatible.base_url.clone(),
        );
    }

    env.insert(
        "MEMORY_BACKEND".into(),
        match settings.memory.backend {
            MemoryBackend::Postgres => "postgres".into(),
            MemoryBackend::Mem0 => "mem0".into(),
            MemoryBackend::Legacy => "legacy".into(),
        },
    );
    env.insert("MEM0_BASE_URL".into(), settings.memory.base_url.clone());
    env.insert(
        "MEMORY_SUBJECT_USER_ID".into(),
        settings.memory.subject_user_id.clone(),
    );
    env.insert(
        "MEMORY_PERSONA_ID".into(),
        settings.memory.persona_id.clone(),
    );
    env.insert(
        "MEM0_OLLAMA_BASE_URL".into(),
        settings.memory.ollama_url.clone(),
    );
    env.insert("OLLAMA_HOST".into(), settings.memory.ollama_url.clone());

    env.insert(
        "DEFAULT_STT_PROVIDER".into(),
        stt_provider_name(settings.stt.provider).into(),
    );
    env.insert(
        "STT_PROVIDER_CHAIN".into(),
        stt_provider_name(settings.stt.provider).into(),
    );
    env.insert("LOCAL_STT_BASE_URL".into(), settings.stt.base_url.clone());
    env.insert("LOCAL_STT_MODEL".into(), settings.stt.model.clone());
    env.insert(
        "YUVI_AUTOSTART_LOCAL_STT".into(),
        bool_flag(
            settings.stt.provider == SttProvider::Local
                && settings.stt.mode == ServiceMode::Managed
                && settings.stt.autostart,
        ),
    );

    env.insert(
        "GPT_SOVITS_TTS_BASE_URL".into(),
        settings.tts.wrapper_url.clone(),
    );
    env.insert(
        "GPT_SOVITS_TTS_UPSTREAM_URL".into(),
        settings.tts.upstream_url.clone(),
    );

    // TTS provider/model selection belongs to ProviderRegistry configuration.
    // Desktop enable/lifecycle preferences must not select a concrete voice.

    if memory_llm_active(settings) {
        env.insert(
            "MEM0_LLM_PROVIDER".into(),
            memory_llm_provider_name(settings).into(),
        );
        env.insert(
            "MEM0_LLM_MODEL".into(),
            settings.memory.llm.model.trim().into(),
        );
        let base_url = settings.memory.llm.base_url.trim();
        if !base_url.is_empty() {
            env.insert("MEM0_LLM_BASE_URL".into(), base_url.into());
        }
    }

    match settings.chat.provider.as_str() {
        "deepseek" => {
            env.insert("DEEPSEEK_CHAT_MODEL".into(), settings.chat.model.clone());
        }
        "openai-compatible" => {
            env.insert(
                "OPENAI_COMPATIBLE_CHAT_MODEL".into(),
                settings.chat.model.clone(),
            );
        }
        _ => {}
    }
    match settings.cognition.provider.as_str() {
        "deepseek" => {
            env.insert(
                "DEEPSEEK_REASONING_MODEL".into(),
                settings.cognition.model.clone(),
            );
        }
        "openai-compatible" => {
            env.insert(
                "OPENAI_COMPATIBLE_REASONING_MODEL".into(),
                settings.cognition.model.clone(),
            );
        }
        _ => {}
    }

    env
}

/// Secrets injected only for managed services that need them.
pub fn secret_env_overrides(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<BTreeMap<String, String>, String> {
    let mut env = BTreeMap::new();

    // Provider keys are injected only for the selected managed model paths.
    if settings.runtime.mode == ServiceMode::Managed && uses_deepseek(settings) {
        if let Some(key) = secrets.get(SECRET_DEEPSEEK_API_KEY)? {
            if !key.trim().is_empty() {
                env.insert("DEEPSEEK_API_KEY".into(), key);
            }
        }
    }
    if settings.runtime.mode == ServiceMode::Managed && uses_openai_compatible(settings) {
        if let Some(key) = secrets.get(SECRET_OPENAI_COMPATIBLE_API_KEY)? {
            if !key.trim().is_empty() {
                env.insert("OPENAI_COMPATIBLE_API_KEY".into(), key);
            }
        }
    }

    // DATABASE_URL only for managed memory consumers we own — never for external.
    if settings.memory.mode == ServiceMode::Managed {
        if let Some(url) = secrets.get(SECRET_DATABASE_URL)? {
            if !url.trim().is_empty() {
                env.insert("DATABASE_URL".into(), url);
            }
        }
    }

    if memory_llm_active(settings) {
        if let Some(key) = secrets.get(SECRET_MEMORY_LLM_API_KEY)? {
            if !key.trim().is_empty() {
                env.insert("MEM0_LLM_API_KEY".into(), key.trim().into());
            }
        }
    }

    // Internal private-cluster password. Never a user setting and never a DATABASE_URL.
    if let Some(password) = secrets.get(SECRET_POSTGRES_LOCAL_PASSWORD)? {
        if !password.trim().is_empty() {
            env.insert("YUVI_POSTGRES_PASSWORD".into(), password);
        }
    }

    Ok(env)
}

pub fn combined_env_for_supervisor(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<BTreeMap<String, String>, String> {
    let mut env = public_env_overrides(settings);
    for (k, v) in secret_env_overrides(settings, secrets)? {
        env.insert(k, v);
    }
    Ok(env)
}

/// Keys that must be removed from Supervisor/child env when not actively injected.
/// Critical for secret delete and managed→external so old values are not inherited.
pub fn unset_env_for_supervisor(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<Vec<String>, String> {
    let mut unset = Vec::new();
    let inject_deepseek = settings.runtime.mode == ServiceMode::Managed
        && uses_deepseek(settings)
        && secrets
            .is_configured(SECRET_DEEPSEEK_API_KEY)
            .unwrap_or(false);
    if !inject_deepseek {
        unset.push("DEEPSEEK_API_KEY".into());
    }

    let inject_openai_compatible = settings.runtime.mode == ServiceMode::Managed
        && uses_openai_compatible(settings)
        && secrets
            .is_configured(SECRET_OPENAI_COMPATIBLE_API_KEY)
            .unwrap_or(false);
    if !inject_openai_compatible {
        push_unique(&mut unset, "OPENAI_COMPATIBLE_API_KEY");
    }

    if settings.chat.provider != "deepseek" {
        push_unique(&mut unset, "DEEPSEEK_CHAT_MODEL");
    }
    if settings.chat.provider != "openai-compatible" {
        push_unique(&mut unset, "OPENAI_COMPATIBLE_CHAT_MODEL");
    }
    if settings.cognition.provider != "deepseek" {
        push_unique(&mut unset, "DEEPSEEK_REASONING_MODEL");
    }
    if settings.cognition.provider != "openai-compatible" {
        push_unique(&mut unset, "OPENAI_COMPATIBLE_REASONING_MODEL");
    }
    if !uses_openai_compatible(settings) {
        push_unique(&mut unset, "OPENAI_COMPATIBLE_API_BASEURL");
    }

    let inject_db = settings.memory.mode == ServiceMode::Managed
        && secrets.is_configured(SECRET_DATABASE_URL).unwrap_or(false);
    if !inject_db {
        unset.push("DATABASE_URL".into());
    }

    let inject_postgres = secrets
        .is_configured(SECRET_POSTGRES_LOCAL_PASSWORD)
        .unwrap_or(false);
    if !inject_postgres {
        push_unique(&mut unset, "YUVI_POSTGRES_PASSWORD");
        push_unique(&mut unset, "PGPASSWORD");
    }

    let memory_llm_active = memory_llm_active(settings);
    if !memory_llm_active {
        push_unique(&mut unset, "MEM0_LLM_PROVIDER");
        push_unique(&mut unset, "MEM0_LLM_MODEL");
        push_unique(&mut unset, "MEM0_LLM_BASE_URL");
        push_unique(&mut unset, "MEM0_LLM_API_KEY");
    } else {
        if settings.memory.llm.base_url.trim().is_empty() {
            push_unique(&mut unset, "MEM0_LLM_BASE_URL");
        }
        if !secrets
            .is_configured(SECRET_MEMORY_LLM_API_KEY)
            .unwrap_or(false)
        {
            push_unique(&mut unset, "MEM0_LLM_API_KEY");
        }
    }


    Ok(unset)
}

fn memory_llm_active(settings: &UserSettings) -> bool {
    settings.memory.enabled
        && settings.memory.mode == ServiceMode::Managed
        && matches!(settings.memory.backend, MemoryBackend::Mem0)
        && !matches!(settings.memory.llm.provider, MemoryLlmProvider::None)
        && !settings.memory.llm.model.trim().is_empty()
}

fn uses_deepseek(settings: &UserSettings) -> bool {
    settings.chat.provider == "deepseek" || settings.cognition.provider == "deepseek"
}

fn uses_openai_compatible(settings: &UserSettings) -> bool {
    settings.chat.provider == "openai-compatible"
        || settings.cognition.provider == "openai-compatible"
}

fn memory_llm_provider_name(settings: &UserSettings) -> &'static str {
    match settings.memory.llm.provider {
        MemoryLlmProvider::Deepseek => "deepseek",
        MemoryLlmProvider::Openai => "openai",
        MemoryLlmProvider::None => "none",
    }
}

fn stt_provider_name(provider: SttProvider) -> &'static str {
    match provider {
        SttProvider::Local => "local",
        SttProvider::Dashscope => "dashscope",
    }
}

fn push_unique(unset: &mut Vec<String>, key: &str) {
    if !unset.iter().any(|existing| existing == key) {
        unset.push(key.into());
    }
}

/// Payload for Supervisor POST /v1/config (secrets only in env map, never logged).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupervisorConfigPush {
    pub env: BTreeMap<String, String>,
    pub unset_env: Vec<String>,
}

pub fn supervisor_config_push(
    settings: &UserSettings,
    secrets: &dyn SecretStore,
) -> Result<SupervisorConfigPush, String> {
    Ok(SupervisorConfigPush {
        env: combined_env_for_supervisor(settings, secrets)?,
        unset_env: unset_env_for_supervisor(settings, secrets)?,
    })
}

fn bool_flag(value: bool) -> String {
    if value {
        "true".into()
    } else {
        "false".into()
    }
}

fn split_http_host_port(url: &str) -> Option<(String, String)> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?.to_string();
    let port = parsed
        .port_or_known_default()
        .map(|p| p.to_string())
        .unwrap_or_else(|| "80".into());
    Some((host, port))
}
