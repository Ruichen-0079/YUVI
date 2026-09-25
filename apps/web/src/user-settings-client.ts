/**
 * Tauri invoke bridge for user settings. No file I/O, no secret values returned.
 * Intentional: field keystrokes never call these helpers — only explicit Save / secret actions.
 */

import { invokeDesktop, isTauriRuntime } from "./tauri-window.js";
import type {
  SecretMutationResultDto,
  SecretStatusDto,
  SettingsChangedEventDto,
  SettingsViewDto,
  UpdateSettingsResultDto,
  UserSecretKey
} from "./user-settings-state.js";

/** Commands that mutate settings or secrets on the Rust side. */
export const USER_SETTINGS_MUTATION_COMMANDS = [
  "update_user_settings",
  "set_user_secret",
  "delete_user_secret"
] as const;

export async function fetchUserSettings(): Promise<SettingsViewDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  return invokeDesktop<SettingsViewDto>("get_user_settings");
}

/**
 * Subscribe to the desktop settings event already emitted by the Tauri side.
 * The synchronous cleanup handle also covers the async listener registration
 * race when a React surface unmounts before the event module is ready.
 */
export function subscribeUserSettingsChanged(
  onChanged: (event: SettingsChangedEventDto) => void
): () => void {
  if (!isTauriRuntime()) return () => undefined;

  let cancelled = false;
  let unlisten: (() => void) | null = null;

  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      if (cancelled) return;
      const remove = await listen<unknown>("settings.changed", (event) => {
        if (cancelled) return;
        const payload = parseSettingsChangedEvent(event.payload);
        if (payload) onChanged(payload);
      });
      if (cancelled) {
        remove();
      } else {
        unlisten = remove;
      }
    } catch {
      // A missing live event bridge leaves the read model fail-closed.
    }
  })();

  return () => {
    cancelled = true;
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
  };
}

function parseSettingsChangedEvent(payload: unknown): SettingsChangedEventDto | null {
  if (!payload || typeof payload !== "object") return null;
  const value = payload as Record<string, unknown>;
  const revision = value["revision"];
  const changedSections = value["changedSections"];
  const restartServices = value["restartServices"];
  if (
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !Array.isArray(changedSections) ||
    !changedSections.every((section): section is string => typeof section === "string") ||
    !Array.isArray(restartServices) ||
    !restartServices.every((service): service is string => typeof service === "string")
  ) {
    return null;
  }
  return { revision, changedSections, restartServices };
}

export async function saveUserSettings(
  patch: Record<string, unknown>
): Promise<UpdateSettingsResultDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  return invokeDesktop<UpdateSettingsResultDto>("update_user_settings", { patch });
}

export async function setUserSecret(
  key: UserSecretKey,
  value: string
): Promise<SecretMutationResultDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  return invokeDesktop<SecretMutationResultDto>("set_user_secret", { key, value });
}

export async function deleteUserSecret(key: UserSecretKey): Promise<SecretMutationResultDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  return invokeDesktop<SecretMutationResultDto>("delete_user_secret", { key });
}

export async function fetchUserSecretStatus(): Promise<SecretStatusDto> {
  if (!isTauriRuntime()) {
    throw new Error("User settings require the Tauri desktop shell.");
  }
  return invokeDesktop<SecretStatusDto>("get_user_secret_status");
}
