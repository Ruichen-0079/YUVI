import { randomUUID } from "node:crypto";
import type { JournalEventRef } from "@companion/protocol";
import {
  commitProductSettings,
  defaultProductSettings,
  readProductSettings,
  withProductSettingsOwner,
  writeProductSettings
} from "../services/product-store.js";
import type {
  ProductPersonCommandInput,
  ProductPersonCommandPort,
  ProductPersonCommandResult,
  NativeControlOwnerCommand
} from "../product-person-command-effects.js";

/** Local route fixture; A9 persistence and dispatch are covered by the opt-in PostgreSQL gate. */
export function createTestProductPersonCommandPort(
  nativeCommand?: (input: NativeControlOwnerCommand) => Promise<ProductPersonCommandResult>
): ProductPersonCommandPort {
  const completed = new Map<string, { input: string; result: ProductPersonCommandResult }>();
  const semanticInput = (input: ProductPersonCommandInput) =>
    "family" in input && input.family === "VOICE_BINDING"
      ? JSON.stringify({
          family: input.family,
          voiceProfileId: input.voiceProfileId,
          desiredBinding: input.operation === "REMOVE" ? null : { personId: input.personId },
          ...(input.previousVoiceProfileId && input.previousVoiceProfileId !== input.voiceProfileId
            ? { previousVoiceProfileId: input.previousVoiceProfileId }
            : {})
        })
      : "family" in input && input.family === "P8_CORRECTION"
        ? JSON.stringify({
            family: input.family,
            operation: input.operation,
            correctionReference: input.correctionReference,
            correction: input.correction
          })
      : JSON.stringify(input);
  return {
    async execute(input: ProductPersonCommandInput, current: () => boolean) {
      const key = semanticInput(input);
      const prior = completed.get(input.commandHandle);
      if (prior)
        return prior.input === key
          ? prior.result
          : { status: "CONFLICT", reason: "COMMAND_HANDLE_REUSED" };
      if (!current()) return { status: "PROVEN_NOT_APPLIED", reason: "STALE_TEST_AUTHORITY" };
      if ("family" in input) {
        const result = nativeCommand
          ? await nativeCommand(input as NativeControlOwnerCommand)
          : { status: "UNAVAILABLE" as const, reason: "TEST_NATIVE_COMMAND_NOT_CONFIGURED" };
        if (result.status === "APPLIED") completed.set(input.commandHandle, { input: key, result });
        return result;
      }
      return withProductSettingsOwner(() => {
        const before = readProductSettings() ?? defaultProductSettings();
        const personId = input.operation === "CREATE" ? randomUUID() : input.personId!;
        const currentPersonRevision = before.personRevisionById?.[personId] ?? null;
        const currentPrimaryRevision = before.primaryPersonRevision ?? null;
        if (
          currentPersonRevision !== input.expectedPersonRevision ||
          currentPrimaryRevision !== input.expectedPrimaryRevision
        )
          return { status: "PROVEN_NOT_APPLIED", reason: "REVISION_MISMATCH" } as const;
        const old = before.people.find((person) => person.id === personId);
        if ((input.operation === "CREATE" && old) || (input.operation === "UPDATE" && !old))
          return { status: "PROVEN_NOT_APPLIED", reason: "TARGET_MISMATCH" } as const;
        const committed = commitProductSettings(
          {
            ...before,
            people: [
              ...before.people.filter((person) => person.id !== personId),
              {
                id: personId,
                displayName: input.displayName,
                personaId: input.personaId,
                notes: input.notes
              }
            ],
            primaryPersonId: input.requestedPrimary ? personId : before.primaryPersonId
          },
          before
        );
        writeProductSettings(committed);
        const receiptRef: JournalEventRef = {
          kind: "JOURNAL_EVENT",
          namespace: "test:product-person",
          eventId: `jev1_${"a".repeat(16)}`
        };
        const result: ProductPersonCommandResult = {
          status: "APPLIED",
          personId,
          receiptRef,
          ...(committed.personRevisionById?.[personId]
            ? { personRevision: committed.personRevisionById[personId] }
            : {}),
          ...(committed.primaryPersonRevision !== undefined
            ? { primaryPersonRevision: committed.primaryPersonRevision }
            : {})
        };
        completed.set(input.commandHandle, { input: key, result });
        return result;
      });
    },
    async resolveExisting(input: ProductPersonCommandInput) {
      const prior = completed.get(input.commandHandle);
      if (!prior) return null;
      return prior.input === semanticInput(input)
        ? prior.result
        : { status: "CONFLICT", reason: "COMMAND_HANDLE_REUSED" };
    }
  };
}
