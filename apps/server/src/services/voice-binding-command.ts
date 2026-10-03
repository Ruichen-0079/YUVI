import type { AppContext } from "../context.js";
import type {
  NativeControlWorkflowChild,
  ProductPersonCommandResult
} from "../product-person-command-effects.js";

export async function governVoiceBinding(
  context: AppContext,
  input: {
    commandHandle: string;
    voiceProfileId: string;
    personId: string;
    personaId: string;
    previousVoiceProfileId?: string;
  },
  current: () => boolean,
  workflowChild?: NativeControlWorkflowChild
): Promise<ProductPersonCommandResult | { status: "ALREADY_BOUND" }> {
  const replay = await context.productPersonCommands.resolveExisting(
    {
      family: "VOICE_BINDING",
      commandHandle: input.commandHandle,
      operation: input.previousVoiceProfileId ? "REPLACE" : "ASSIGN",
      voiceProfileId: input.voiceProfileId,
      personaId: input.personaId,
      personId: input.personId,
      expectedBindingRevision: null,
      ...(input.previousVoiceProfileId
        ? {
            previousVoiceProfileId: input.previousVoiceProfileId,
            expectedPreviousBindingRevision: null
          }
        : {})
    },
    current,
    workflowChild
  );
  if (replay) return replay;
  const owner = await context.runtime.getVoiceProfileBindingAuthorityState();
  if (owner.status !== "AVAILABLE") return { status: "UNAVAILABLE", reason: "BINDING_OWNER_UNAVAILABLE" };
  const target = owner.bindings.find(
    (binding) => binding.voiceProfileId === input.voiceProfileId && binding.personaId === input.personaId
  );
  if (target?.status === "CONFLICT") return { status: "CONFLICT", reason: "TARGET_BINDING_CONFLICT" };

  const activeTargetBindings = owner.bindings.filter(
    (binding) => binding.voiceProfileId === input.voiceProfileId && binding.status === "ACTIVE"
  );
  if (activeTargetBindings.length > 1)
    return { status: "CONFLICT", reason: "MULTIPLE_CURRENT_BINDING_SCOPES" };
  let previousBinding = activeTargetBindings[0];
  if (input.previousVoiceProfileId) {
    const activePreviousBindings = owner.bindings.filter(
      (binding) => binding.voiceProfileId === input.previousVoiceProfileId && binding.status === "ACTIVE"
    );
    if (activePreviousBindings.length !== 1 || activePreviousBindings[0]!.personId !== input.personId)
      return { status: "CONFLICT", reason: "PREVIOUS_BINDING_CHANGED" };
    previousBinding = activePreviousBindings[0];
  }
  if (previousBinding?.status === "CONFLICT")
    return { status: "CONFLICT", reason: "PREVIOUS_BINDING_CHANGED" };
  if (
    !input.previousVoiceProfileId &&
    target?.status === "ACTIVE" &&
    target.personId === input.personId
  )
    return { status: "ALREADY_BOUND" };

  const previousIsSeparateScope = previousBinding !== undefined &&
    (previousBinding.voiceProfileId !== input.voiceProfileId || previousBinding.personaId !== input.personaId);
  if (input.previousVoiceProfileId && previousBinding && previousIsSeparateScope && previousBinding.personId !== input.personId)
    return { status: "CONFLICT", reason: "PREVIOUS_BINDING_CHANGED" };
  const operation = input.previousVoiceProfileId || target?.status === "ACTIVE" || previousIsSeparateScope
    ? "REPLACE" as const
    : "ASSIGN" as const;
  return context.productPersonCommands.execute(
    {
      family: "VOICE_BINDING",
      commandHandle: input.commandHandle,
      operation,
      voiceProfileId: input.voiceProfileId,
      personaId: input.personaId,
      personId: input.personId,
      expectedBindingRevision: target?.revision ?? null,
      ...(previousIsSeparateScope
        ? {
            previousVoiceProfileId: previousBinding!.voiceProfileId,
            ...(previousBinding!.personaId !== input.personaId
              ? { previousPersonaId: previousBinding!.personaId }
              : {}),
            expectedPreviousBindingRevision: previousBinding!.revision
          }
        : {})
    },
    current,
    workflowChild
  );
}
