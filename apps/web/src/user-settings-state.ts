/**
 * Frontend DTO + reducer for Tauri user settings.
 * Secrets never appear as values — only configured flags.
 */

export type ServiceMode = "managed" | "external";
export type MemoryBackend = "postgres" | "mem0" | "legacy";
export type MemoryLlmProvider = "none" | "deepseek" | "openai";
export type SttProvider = "local" | "dashscope";

export type UserSecretKey =
  | "chat.deepseekApiKey"
  | "models.openaiCompatibleApiKey"
  | "memory.databaseUrl"
  | "memory.llmApiKey";

export type UserSettingsDto = {
  schemaVersion: number;
  app: { language: string };
  chat: { provider: string; model: string };
  cognition: { provider: string; model: string };
  openaiCompatible: { baseUrl: string };
  runtime: { mode: ServiceMode; autostart: boolean; url: string };
  memory: {
    enabled: boolean;
    backend: MemoryBackend;
    mode: ServiceMode;
    baseUrl: string;
    subjectUserId: string;
    personaId: string;
    ollamaUrl: string;
    llm: {
      provider: MemoryLlmProvider;
      model: string;
      baseUrl: string;
    };
  };
  tts: {
    enabled: boolean;
    mode: ServiceMode;
    wrapperUrl: string;
    upstreamUrl: string;
  };
  stt: {
    provider: SttProvider;
    mode: ServiceMode;
    autostart: boolean;
    baseUrl: string;
    model: string;
  };
  companion: { alwaysOnTop: boolean };
  proactive: { enabled: boolean };
};

export type TtsSettingsProjection = Pick<UserSettingsDto["tts"], "enabled" | "mode">;

export type SecretStatusDto = {
  deepseekApiKey: boolean;
  openaiCompatibleApiKey: boolean;
  databaseUrl: boolean;
  memoryLlmApiKey: boolean;
};

export type SettingsViewDto = {
  settings: UserSettingsDto;
  secrets: SecretStatusDto;
  revision: number;
  configPath: string;
  loadError: string | null;
};

export type SettingsChangedEventDto = {
  revision: number;
  changedSections: string[];
  restartServices: string[];
};

export type SupervisorSyncStatusDto = {
  applied: boolean;
  error: string | null;
};

export type UpdateSettingsResultDto = {
  saved: boolean;
  restartServices: string[];
  restartApplication: boolean;
  revision: number;
  settings: UserSettingsDto;
  secrets: SecretStatusDto;
  supervisorSync: SupervisorSyncStatusDto;
};

export type SecretMutationResultDto = {
  saved: boolean;
  secrets: SecretStatusDto;
  restartServices: string[];
  supervisorSync: SupervisorSyncStatusDto;
};

/** Keep service restart hints deterministic for both mutations and settings saves. */
export function mergeRestartServices(...serviceLists: readonly (readonly string[])[]): string[] {
  const ordered = ["runtime", "memory", "tts", "local_stt"];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const service of ordered) {
    if (serviceLists.some((services) => services.includes(service))) {
      seen.add(service);
      result.push(service);
    }
  }
  for (const services of serviceLists) {
    for (const service of services) {
      if (!seen.has(service)) {
        seen.add(service);
        result.push(service);
      }
    }
  }
  return result;
}

/** User-facing save notice: persistence vs live supervisor refresh. */
export function buildSaveMessage(input: {
  saved: boolean;
  restartServices: string[];
  supervisorSync?: SupervisorSyncStatusDto | null;
  kind?: "settings" | "secret";
}): string {
  const prefix = input.kind === "secret" ? "Secret updated" : "Settings saved";
  if (input.supervisorSync && !input.supervisorSync.applied) {
    const savedPrefix = input.kind === "secret" ? "Secret saved" : "Settings saved";
    return `${savedPrefix}, but Supervisor was unavailable. Reopen YUVI or Save again to apply it to managed services.`;
  }
  if (input.restartServices.length > 0) {
    if (input.kind === "secret") {
      return `${prefix}. Applying changes to: ${input.restartServices.join(", ")}.`;
    }
    return `${prefix}. Services may reload: ${input.restartServices.join(", ")}.`;
  }
  return `${prefix}.`;
}

export type UserSettingsForm = {
  language: string;
  chatProvider: string;
  chatModel: string;
  cognitionProvider: string;
  cognitionModel: string;
  openaiCompatibleBaseUrl: string;
  deepseekApiKeyInput: string;
  openaiCompatibleApiKeyInput: string;
  runtimeMode: ServiceMode;
  runtimeAutostart: boolean;
  runtimeUrl: string;
  memoryEnabled: boolean;
  memoryBackend: MemoryBackend;
  memoryMode: ServiceMode;
  memoryBaseUrl: string;
  subjectUserId: string;
  personaId: string;
  ollamaUrl: string;
  databaseUrlInput: string;
  memoryLlmProvider: MemoryLlmProvider;
  memoryLlmModel: string;
  memoryLlmBaseUrl: string;
  memoryLlmApiKeyInput: string;
  ttsEnabled: boolean;
  ttsMode: ServiceMode;
  ttsWrapperUrl: string;
  ttsUpstreamUrl: string;
  sttProvider: SttProvider;
  sttMode: ServiceMode;
  sttAutostart: boolean;
  sttBaseUrl: string;
  sttModel: string;
  companionAlwaysOnTop: boolean;
  proactiveEnabled: boolean;
};

export type UserSettingsUiState = {
  loading: boolean;
  saving: boolean;
  error: string | null;
  loadError: string | null;
  configPath: string | null;
  revision: number;
  secrets: SecretStatusDto;
  form: UserSettingsForm;
  lastRestartServices: string[];
  saveMessage: string | null;
};

export const emptySecretStatus = (): SecretStatusDto => ({
  deepseekApiKey: false,
  openaiCompatibleApiKey: false,
  databaseUrl: false,
  memoryLlmApiKey: false
});

export const defaultUserSettingsForm = (): UserSettingsForm => ({
  language: "zh-CN",
  chatProvider: "openai-compatible",
  chatModel: "deepseek-ai/DeepSeek-V4-Flash-0731",
  cognitionProvider: "openai-compatible",
  cognitionModel: "zai-org/GLM-5.3-Flash",
  openaiCompatibleBaseUrl: "https://api.deepinfra.com/v1/openai",
  deepseekApiKeyInput: "",
  openaiCompatibleApiKeyInput: "",
  runtimeMode: "managed",
  runtimeAutostart: true,
  runtimeUrl: "http://127.0.0.1:6121",
  memoryEnabled: true,
  memoryBackend: "mem0",
  memoryMode: "managed",
  memoryBaseUrl: "http://127.0.0.1:6131",
  subjectUserId: "local-owner",
  personaId: "alice",
  ollamaUrl: "http://127.0.0.1:11434",
  databaseUrlInput: "",
  memoryLlmProvider: "none",
  memoryLlmModel: "",
  memoryLlmBaseUrl: "",
  memoryLlmApiKeyInput: "",
  // Fresh installs do not ship an Alice GPT-SoVITS runtime or voice assets.
  // External mode remains available when the user supplies that service.
  ttsEnabled: false,
  ttsMode: "external",
  ttsWrapperUrl: "http://127.0.0.1:9881",
  ttsUpstreamUrl: "http://127.0.0.1:9880",
  sttProvider: "dashscope",
  sttMode: "external",
  sttAutostart: false,
  sttBaseUrl: "http://127.0.0.1:9876",
  sttModel: "sense-voice-zh-en-ja-ko-yue-2024-07-17-int8",
  companionAlwaysOnTop: true,
  proactiveEnabled: false
});

export const initialUserSettingsUiState = (): UserSettingsUiState => ({
  loading: true,
  saving: false,
  error: null,
  loadError: null,
  configPath: null,
  revision: 0,
  secrets: emptySecretStatus(),
  form: defaultUserSettingsForm(),
  lastRestartServices: [],
  saveMessage: null
});

export function formFromView(view: SettingsViewDto): UserSettingsForm {
  const s = view.settings;
  return {
    language: s.app.language,
    chatProvider: s.chat.provider,
    chatModel: s.chat.model,
    cognitionProvider: s.cognition.provider,
    cognitionModel: s.cognition.model,
    openaiCompatibleBaseUrl: s.openaiCompatible.baseUrl,
    deepseekApiKeyInput: "",
    openaiCompatibleApiKeyInput: "",
    runtimeMode: s.runtime.mode,
    runtimeAutostart: s.runtime.autostart,
    runtimeUrl: s.runtime.url,
    memoryEnabled: s.memory.enabled,
    memoryBackend: s.memory.backend,
    memoryMode: s.memory.mode,
    memoryBaseUrl: s.memory.baseUrl,
    subjectUserId: s.memory.subjectUserId,
    personaId: s.memory.personaId,
    ollamaUrl: s.memory.ollamaUrl,
    databaseUrlInput: "",
    memoryLlmProvider: s.memory.llm.provider,
    memoryLlmModel: s.memory.llm.model,
    memoryLlmBaseUrl: s.memory.llm.baseUrl,
    memoryLlmApiKeyInput: "",
    ttsEnabled: s.tts.enabled,
    ttsMode: s.tts.mode,
    ttsWrapperUrl: s.tts.wrapperUrl,
    ttsUpstreamUrl: s.tts.upstreamUrl,
    sttProvider: s.stt.provider,
    sttMode: s.stt.mode,
    sttAutostart: s.stt.autostart,
    sttBaseUrl: s.stt.baseUrl,
    sttModel: s.stt.model,
    companionAlwaysOnTop: s.companion.alwaysOnTop,
    proactiveEnabled: s.proactive.enabled
  };
}

export function patchFromForm(form: UserSettingsForm): Record<string, unknown> {
  return {
    app: { language: form.language },
    chat: { provider: form.chatProvider, model: form.chatModel },
    cognition: { provider: form.cognitionProvider, model: form.cognitionModel },
    openaiCompatible: { baseUrl: form.openaiCompatibleBaseUrl },
    runtime: {
      mode: form.runtimeMode,
      autostart: form.runtimeAutostart,
      url: form.runtimeUrl
    },
    memory: {
      enabled: form.memoryEnabled,
      backend: form.memoryBackend,
      mode: form.memoryMode,
      baseUrl: form.memoryBaseUrl,
      subjectUserId: form.subjectUserId,
      personaId: form.personaId,
      ollamaUrl: form.ollamaUrl,
      llm: {
        provider: form.memoryLlmProvider,
        model: form.memoryLlmModel,
        baseUrl: form.memoryLlmBaseUrl
      }
    },
    tts: {
      enabled: form.ttsEnabled,
      mode: form.ttsMode,
      wrapperUrl: form.ttsWrapperUrl,
      upstreamUrl: form.ttsUpstreamUrl
    },
    stt: {
      provider: form.sttProvider,
      mode: form.sttMode,
      autostart: form.sttAutostart,
      baseUrl: form.sttBaseUrl,
      model: form.sttModel
    },
    companion: { alwaysOnTop: form.companionAlwaysOnTop },
    proactive: { enabled: form.proactiveEnabled }
  };
}

/** Ensure no secret field names/values leak into serialised DTO snapshots. */
export function assertNoSecretMaterial(payload: unknown): void {
  const text = JSON.stringify(payload);
  if (text.includes("MEM0_LLM_API_KEY") || text.includes("P3_UI_MEMORY_LLM_SECRET_NEVER_EXPOSE")) {
    throw new Error("secret material must not appear in settings DTO");
  }
  if (/postgres(ql)?:\/\/[^:]+:[^@]+@/i.test(text)) {
    throw new Error("database password must not appear in settings DTO");
  }
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (
        key?.endsWith("ApiKey") ||
        key?.endsWith("ApiKeyInput") ||
        key === "databaseUrl" ||
        key === "databaseUrlInput"
      ) {
        if (value.length > 0) {
          throw new Error("secret material must not appear in settings DTO");
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item));
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey);
      }
    }
  };
  visit(payload);
}

export function validateUserSettingsForm(form: UserSettingsForm): string | null {
  for (const [label, provider, model] of [
    ["Chat", form.chatProvider, form.chatModel],
    ["Cognition", form.cognitionProvider, form.cognitionModel]
  ] as const) {
    if (provider !== "deepseek" && provider !== "openai-compatible") {
      return `${label} provider must be DeepSeek or OpenAI-compatible.`;
    }
    if (!model.trim()) {
      return `${label} model is required.`;
    }
  }
  if (form.chatProvider === "openai-compatible" || form.cognitionProvider === "openai-compatible") {
    const baseUrl = form.openaiCompatibleBaseUrl.trim();
    try {
      const parsed = new URL(baseUrl);
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        return "OpenAI-compatible base URL must use HTTP(S) without credentials.";
      }
    } catch {
      return "OpenAI-compatible base URL must be a valid HTTP(S) URL without credentials.";
    }
  }
  if (form.memoryLlmProvider !== "none" && !form.memoryLlmModel.trim()) {
    return "Memory LLM model is required when a provider is selected.";
  }
  if (form.memoryLlmProvider !== "none") {
    const baseUrl = form.memoryLlmBaseUrl.trim();
    if (baseUrl) {
      try {
        const parsed = new URL(baseUrl);
        if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
          return "Memory LLM base URL must use HTTP(S) without credentials.";
        }
      } catch {
        return "Memory LLM base URL must be a valid HTTP(S) URL without credentials.";
      }
    }
  }
  if (!form.sttModel.trim()) {
    return "STT model is required.";
  }
  try {
    const parsed = new URL(form.sttBaseUrl.trim());
    if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
      return "STT base URL must use HTTP(S) without credentials.";
    }
  } catch {
    return "STT base URL must be a valid HTTP(S) URL without credentials.";
  }
  return null;
}

export type UserSettingsAction =
  | { type: "load-start" }
  | { type: "load-success"; view: SettingsViewDto }
  | { type: "load-error"; error: string }
  | { type: "field"; key: keyof UserSettingsForm; value: string | boolean }
  | { type: "save-start" }
  | { type: "save-success"; result: UpdateSettingsResultDto; clearSecrets: boolean }
  | { type: "save-error"; error: string }
  | {
      type: "secrets-updated";
      key: UserSecretKey;
      secrets: SecretStatusDto;
      restartServices?: string[];
      supervisorSync?: SupervisorSyncStatusDto | null;
      saved?: boolean;
    };

export function reduceUserSettings(
  state: UserSettingsUiState,
  action: UserSettingsAction
): UserSettingsUiState {
  switch (action.type) {
    case "load-start":
      return { ...state, loading: true, error: null };
    case "load-success":
      if (action.view.revision < state.revision) return state;
      return {
        ...state,
        loading: false,
        error: null,
        loadError: action.view.loadError,
        configPath: action.view.configPath,
        revision: action.view.revision,
        secrets: action.view.secrets,
        form: formFromView(action.view),
        saveMessage: null
      };
    case "load-error":
      return { ...state, loading: false, error: action.error };
    case "field":
      return {
        ...state,
        form: { ...state.form, [action.key]: action.value },
        saveMessage: null
      };
    case "save-start":
      return { ...state, saving: true, error: null, saveMessage: null };
    case "save-success": {
      if (action.result.revision < state.revision) {
        return { ...state, saving: false };
      }
      const form = formFromView({
        settings: action.result.settings,
        secrets: action.result.secrets,
        revision: action.result.revision,
        configPath: state.configPath ?? "",
        loadError: null
      });
      if (action.clearSecrets) {
        form.deepseekApiKeyInput = "";
        form.openaiCompatibleApiKeyInput = "";
        form.databaseUrlInput = "";
        form.memoryLlmApiKeyInput = "";
      } else {
        form.deepseekApiKeyInput = state.form.deepseekApiKeyInput;
        form.openaiCompatibleApiKeyInput = state.form.openaiCompatibleApiKeyInput;
        form.databaseUrlInput = state.form.databaseUrlInput;
        form.memoryLlmApiKeyInput = state.form.memoryLlmApiKeyInput;
      }
      const restart = action.result.restartServices;
      return {
        ...state,
        saving: false,
        revision: action.result.revision,
        secrets: action.result.secrets,
        form,
        lastRestartServices: restart,
        saveMessage: buildSaveMessage({
          saved: action.result.saved,
          restartServices: restart,
          supervisorSync: action.result.supervisorSync,
          kind: "settings"
        })
      };
    }
    case "save-error":
      return { ...state, saving: false, error: action.error };
    case "secrets-updated": {
      const restart = action.restartServices ?? state.lastRestartServices;
      const form = { ...state.form };
      if (action.key === "chat.deepseekApiKey") form.deepseekApiKeyInput = "";
      if (action.key === "models.openaiCompatibleApiKey") form.openaiCompatibleApiKeyInput = "";
      if (action.key === "memory.databaseUrl") form.databaseUrlInput = "";
      if (action.key === "memory.llmApiKey") form.memoryLlmApiKeyInput = "";
      return {
        ...state,
        secrets: action.secrets,
        form,
        lastRestartServices: restart,
        saveMessage: buildSaveMessage({
          saved: action.saved !== false,
          restartServices: restart,
          ...(action.supervisorSync !== undefined ? { supervisorSync: action.supervisorSync } : {}),
          kind: "secret"
        })
      };
    }
    default:
      return state;
  }
}
