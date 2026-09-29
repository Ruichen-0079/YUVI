import { describe, expect, it } from "vitest";
import {
  editableKeys,
  getPendingRestartKeys,
  getRuntimeSettingApplyMode,
  sanitizeUrlUserinfo,
  validateRuntimeSettings
} from "./runtime-settings.js";

describe("runtime settings contract", () => {
  it("has one apply mode for every editable key", () => {
    expect(editableKeys).toHaveLength(new Set(editableKeys).size);
    expect(editableKeys.every((key) => getRuntimeSettingApplyMode(key))).toBe(true);
    expect(getRuntimeSettingApplyMode("SERVER_PORT")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("OUTPUT_LANGUAGE")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("DEEPSEEK_CHAT_MODEL")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("DEFAULT_CHAT_PROVIDER")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("DEFAULT_REASONING_PROVIDER")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("OPENAI_COMPATIBLE_CHAT_MODEL")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("OPENAI_COMPATIBLE_REASONING_MODEL")).toBe("hot_reload");
    expect(getRuntimeSettingApplyMode("OPENAI_COMPATIBLE_PROACTIVE_DECISION_MODEL")).toBe(
      "hot_reload"
    );
    expect(getRuntimeSettingApplyMode("OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT")).toBe(
      "hot_reload"
    );
    expect(getRuntimeSettingApplyMode("MEMORY_VECTOR_IVFFLAT_PROBES")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("EMBEDDING_PROVIDER_CHAIN")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("EMBEDDING_PROVIDER")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("LOCAL_EMBEDDING_MODEL")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("LOCAL_EMBEDDING_DIMENSIONS")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("NVIDIA_EMBEDDING_MODEL")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("NVIDIA_EMBEDDING_DIMENSIONS")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("EMBEDDING_MODEL")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("EMBEDDING_DIMENSIONS")).toBe("restart_required");
    expect(getRuntimeSettingApplyMode("GPT_SOVITS_TTS_GPT_WEIGHTS")).toBe("restart_required");
  });

  it("reports pending restart only when desired restart state differs from active state", () => {
    const active = {
      MEMORY_REPOSITORY: "in-memory",
      SERVER_PORT: "6121",
      PROVIDER_ALLOW_MOCKS: "false"
    };
    expect(getPendingRestartKeys({ ...active, SERVER_PORT: "6122" }, active)).toContain(
      "SERVER_PORT"
    );
    expect(getPendingRestartKeys({ ...active, MEMORY_REPOSITORY: "memory" }, active)).not.toContain(
      "MEMORY_REPOSITORY"
    );
    expect(getPendingRestartKeys({ SERVER_PORT: "6121" }, {})).not.toContain("SERVER_PORT");
    expect(getPendingRestartKeys({}, { SERVER_PORT: "6121" })).not.toContain("SERVER_PORT");
  });

  it("validates typed settings without echoing values", () => {
    const result = validateRuntimeSettings({
      MEMORY_REPOSITORY: "sqlite",
      MEMORY_EXTRACTOR: "external",
      EVENT_BUS: "nats",
      SERVER_PORT: "6121abc",
      PROVIDER_ALLOW_MOCKS: "maybe",
      DEFAULT_CHAT_PROVIDER: "unsupported",
      DEFAULT_REASONING_PROVIDER: "",
      CHAT_PROVIDER_CHAIN: "deepseek,unknown",
      OPENAI_COMPATIBLE_API_BASEURL: "not-a-url",
      OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT: "unknown",
      XAI_API_BASEURL: "not-a-url",
      EMBEDDING_PROVIDER: "unsupported",
      GPT_SOVITS_TTS_TOP_P: "2"
    });
    expect(result.fieldErrors).toMatchObject({
      MEMORY_REPOSITORY: expect.any(String),
      MEMORY_EXTRACTOR: expect.any(String),
      EVENT_BUS: expect.any(String),
      EMBEDDING_PROVIDER: expect.any(String),
      SERVER_PORT: expect.any(String),
      PROVIDER_ALLOW_MOCKS: expect.any(String),
      DEFAULT_CHAT_PROVIDER: expect.any(String),
      DEFAULT_REASONING_PROVIDER: expect.any(String),
      CHAT_PROVIDER_CHAIN: expect.any(String),
      OPENAI_COMPATIBLE_API_BASEURL: expect.any(String),
      OPENAI_COMPATIBLE_ASSISTANT_CONTINUATION_FORMAT: expect.any(String),
      XAI_API_BASEURL: expect.any(String),
      GPT_SOVITS_TTS_TOP_P: expect.any(String)
    });
    expect(JSON.stringify(result)).not.toContain("sqlite");

    expect(
      validateRuntimeSettings({ MEMORY_REPOSITORY: "postgres" }).fieldErrors["MEMORY_REPOSITORY"]
    ).toEqual(expect.any(String));
    expect(validateRuntimeSettings({}).fieldErrors).not.toHaveProperty("EMBEDDING_PROVIDER");
    expect(validateRuntimeSettings({ MEMORY_EXTRACTOR: "" }).fieldErrors).toMatchObject({
      MEMORY_EXTRACTOR: expect.any(String)
    });
    expect(validateRuntimeSettings({ MEMORY_EXTRACTOR: "llm" }).fieldErrors).not.toHaveProperty(
      "MEMORY_EXTRACTOR"
    );
    expect(
      validateRuntimeSettings({ EMBEDDING_PROVIDER: "openai-compatible" }).fieldErrors
    ).not.toHaveProperty("EMBEDDING_PROVIDER");
    expect(validateRuntimeSettings({ EMBEDDING_PROVIDER: "" }).fieldErrors).toMatchObject({
      EMBEDDING_PROVIDER: expect.any(String)
    });
    expect(
      validateRuntimeSettings({
        OPENAI_COMPATIBLE_API_BASEURL: "https://user:password@gateway.example/v1"
      }).fieldErrors["OPENAI_COMPATIBLE_API_BASEURL"]
    ).toContain("credentials");
    expect(validateRuntimeSettings({ OUTPUT_LANGUAGE: "EN" }).fieldErrors).not.toHaveProperty(
      "OUTPUT_LANGUAGE"
    );
    expect(validateRuntimeSettings({ OUTPUT_LANGUAGE: "ja" }).fieldErrors).not.toHaveProperty(
      "OUTPUT_LANGUAGE"
    );
    expect(validateRuntimeSettings({ OUTPUT_LANGUAGE: "FR" }).fieldErrors).toMatchObject({
      OUTPUT_LANGUAGE: expect.any(String)
    });
  });

  it("redacts URL userinfo without changing the URL path", () => {
    expect(sanitizeUrlUserinfo("https://user:password@example.com/v1")).toBe(
      "https://example.com/v1"
    );
    expect(sanitizeUrlUserinfo("http://127.0.0.1:8080/v1")).toBe("http://127.0.0.1:8080/v1");
  });
});
