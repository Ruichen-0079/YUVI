import type { MemoryClaimIdentityInput, MemoryEvent } from "@companion/memory";
import {
  projectVoicePersonForCharacter,
  resolveP8VoicePerson,
  voicePersonClaimAssertor,
  type P8CharacterSpeakerView,
  type P8IdentityAddress,
  type P8AcousticObservationReference,
  type P8VoiceBindingProjection,
  type P8VoicePersonResolution,
  type P8VoicePersonUnresolvedReason,
  type P8VoiceProfileMatch
} from "@companion/p8";
import type { STTOutput, STTSegment, VoiceProfileMatch } from "@companion/providers";

/**
 * Observation-only voice identity interpretation (Atom 13B).
 *
 * This never admits an interaction, never writes Memory, and never feeds
 * Character biometric internals. Runtime still requires an explicit
 * interaction source (PTT / controller) to create a user turn.
 */

export type SpeechObservationIdentityInterpretation = Readonly<{
  observationId?: string;
  captureEpoch?: string;
  resolutions: readonly P8VoicePersonResolution[];
  characterSpeakers: readonly P8CharacterSpeakerView[];
  claimAssertor: MemoryClaimIdentityInput;
  claimAssertorReason?: P8VoicePersonUnresolvedReason;
  remainsObservation: true;
}>;

export type InterpretSpeechObservationIdentityInput = Readonly<{
  observation: STTOutput;
  address: P8IdentityAddress;
  scopeReference: string;
  longTermEvents?: readonly MemoryEvent[];
  trustedAssertorEntityIds?: readonly string[];
  /** Production Runtime supplies this property even when it has no usable projection. */
  bindingProjections?: readonly P8VoiceBindingProjection[];
  acousticObservationReference?: P8AcousticObservationReference;
}>;

export function interpretSpeechObservationIdentity(
  input: InterpretSpeechObservationIdentityInput
): SpeechObservationIdentityInterpretation {
  const observation = input.observation;
  const segments = observation.segments ?? [];
  const clusterIds = uniqueClusterIds(segments);
  const shared = {
    address: input.address,
    scopeReference: input.scopeReference,
    ...(input.longTermEvents === undefined ? {} : { longTermEvents: input.longTermEvents }),
    ...(input.trustedAssertorEntityIds === undefined
      ? {}
      : { trustedAssertorEntityIds: input.trustedAssertorEntityIds }),
    ...(input.bindingProjections === undefined
      ? {}
      : { bindingProjections: input.bindingProjections }),
    ...(input.acousticObservationReference === undefined
      ? {}
      : { acousticObservationReference: input.acousticObservationReference }),
    transcriptClaim: observation.text
  };
  const resolutions =
    clusterIds.length > 0
      ? clusterIds.map((speakerClusterId) => {
          const voiceProfileMatch = matchForCluster(
            segments,
            observation.voiceProfileMatch,
            speakerClusterId,
            clusterIds
          );
          return resolveP8VoicePerson({
            ...shared,
            speakerClusterId,
            ...(voiceProfileMatch === undefined ? {} : { voiceProfileMatch })
          });
        })
      : [
          (() => {
            const observationMatch = toP8Match(observation.voiceProfileMatch);
            return resolveP8VoicePerson({
              ...shared,
              ...(observationMatch === undefined ? {} : { voiceProfileMatch: observationMatch })
            });
          })()
        ];

  const attribution = voicePersonClaimAssertor({
    resolutions,
    segments: segments.map((segment) => {
      const voiceProfileMatch = toP8Match(segment.voiceProfileMatch);
      return {
        ...(segment.speakerClusterId === undefined
          ? {}
          : { speakerClusterId: segment.speakerClusterId }),
        ...(segment.text === undefined ? {} : { text: segment.text }),
        ...(voiceProfileMatch === undefined ? {} : { voiceProfileMatch })
      };
    }),
    wholeTranscript: observation.text
  });

  return Object.freeze({
    ...(observation.observationId === undefined
      ? {}
      : { observationId: observation.observationId }),
    ...(observation.captureEpoch === undefined ? {} : { captureEpoch: observation.captureEpoch }),
    resolutions: Object.freeze(resolutions),
    characterSpeakers: Object.freeze(resolutions.map(projectVoicePersonForCharacter)),
    claimAssertor: attribution.assertor,
    ...(attribution.reason === undefined ? {} : { claimAssertorReason: attribution.reason }),
    remainsObservation: true as const
  });
}

function matchForCluster(
  segments: readonly STTSegment[],
  observationMatch: VoiceProfileMatch | undefined,
  speakerClusterId: string,
  clusterIds: readonly string[]
): P8VoiceProfileMatch | undefined {
  const segment = segments.find((item) => item.speakerClusterId === speakerClusterId);
  const clusterMatch = toP8Match(segment?.voiceProfileMatch);
  if (clusterMatch !== undefined) return clusterMatch;
  if (clusterIds.length > 1) return { status: "NO_MATCH" };
  return toP8Match(observationMatch);
}

function toP8Match(match: VoiceProfileMatch | undefined): P8VoiceProfileMatch | undefined {
  if (!match) return undefined;
  return {
    status: match.status,
    ...(match.voiceProfileId === undefined ? {} : { voiceProfileId: match.voiceProfileId })
  };
}

function uniqueClusterIds(segments: readonly STTSegment[]): string[] {
  const ids: string[] = [];
  for (const segment of segments) {
    const id = segment.speakerClusterId;
    if (id === undefined || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}
