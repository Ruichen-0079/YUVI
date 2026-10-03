import type { AppContext } from "../context.js";
import { productVoiceProfiles } from "./packaged-voice.js";
import type {
  NativeControlWorkflowChild,
  ProductPersonCommandResult
} from "../product-person-command-effects.js";

export async function executeAcousticProfileCommand(
  context: AppContext,
  input: {
    commandHandle: string;
    operation: "ENROLL" | "DELETE";
    voiceProfileId: string;
    label?: string;
    sampleReferences?: readonly string[];
    sampleDigests?: readonly string[];
  },
  current: () => boolean,
  workflowChild?: NativeControlWorkflowChild
): Promise<ProductPersonCommandResult> {
  const profiles = productVoiceProfiles(context);
  if (!profiles?.readAuthorityState)
    return { status: "UNAVAILABLE", reason: "ACOUSTIC_OWNER_UNAVAILABLE" };
  let snapshot;
  try {
    snapshot = await profiles.readAuthorityState();
  } catch {
    return { status: "UNAVAILABLE", reason: "ACOUSTIC_OWNER_UNAVAILABLE" };
  }
  if (!snapshot.complete)
    return { status: "UNAVAILABLE", reason: "ACOUSTIC_OWNER_ENUMERATION_INCOMPLETE" };
  return context.productPersonCommands.execute(
    {
      family: "ACOUSTIC_PROFILE",
      commandHandle: input.commandHandle,
      operation: input.operation,
      voiceProfileId: input.voiceProfileId,
      expectedAcousticRevision: snapshot.revision,
      ...(input.label ? { label: input.label } : {}),
      ...(input.sampleReferences ? { sampleReferences: [...input.sampleReferences] } : {}),
      ...(input.sampleDigests ? { sampleDigests: [...input.sampleDigests] } : {})
    },
    current,
    workflowChild
  );
}
