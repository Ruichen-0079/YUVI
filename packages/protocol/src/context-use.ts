import { z } from "zod";
const token = z.string().min(1).max(1024);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const ContextAvailabilitySchema = z.enum([
  "AVAILABLE",
  "EMPTY",
  "NOT_USED",
  "UNAVAILABLE",
  "ERROR",
  "NOT_RETAINED",
  "REDACTED",
  "DELETED",
  "STALE",
  "LEGACY_UNLINEAGED"
]);
export const ContextSourceUseSchema = z
  .object({
    owner: z.enum([
      "JOURNAL",
      "CONVERSATION",
      "MEMORY",
      "PROFILE",
      "PERSON",
      "VOICE_BINDING",
      "P8",
      "INPUT"
    ]),
    reference: token,
    revision: token.nullable(),
    digest: digest.nullable(),
    availability: ContextAvailabilitySchema,
    revisionKind: z.enum(["NATIVE", "OBSERVED_SNAPSHOT", "LEGACY_UNLINEAGED", "NOT_USED"]),
    selection: z.enum(["SELECTED", "AVAILABLE", "OMITTED"]),
    semanticReferences: z.array(z.string().min(1).max(8192)).max(1024).optional(),
    reason: token,
    roots: z.array(token).max(1024)
  })
  .strict();
export type ContextSourceUse = z.infer<typeof ContextSourceUseSchema>;
export const ContextBlockSchema = z
  .object({
    key: token,
    epistemicState: token.optional(),
    digest,
    characters: z.number().int().nonnegative(),
    sourceReferences: z.array(token).max(1024),
    stability: z.enum(["STABLE", "VOLATILE"])
  })
  .strict();
export type ContextBlock = z.infer<typeof ContextBlockSchema>;
export const ContextManifestSchema = z
  .object({
    version: z.literal("context-use-manifest.v1"),
    namespace: token,
    executionId: token,
    assemblyOrdinal: z.string().regex(/^[1-9][0-9]*$/),
    scope: token,
    assemblyVersion: token,
    selectionVersion: token,
    enumeration: z.enum(["OBSERVED_WINDOW", "TOP_K", "NOT_USED"]),
    sources: z.array(ContextSourceUseSchema).max(4096),
    blocks: z.array(ContextBlockSchema).max(128),
    stable: z.object({ version: token, digest }).strict(),
    volatile: z.object({ version: token, digest }).strict()
  })
  .strict();
export type ContextManifest = z.infer<typeof ContextManifestSchema>;
export const ContextExposureSchema = z
  .object({
    version: z.literal("context-exposure.v1"),
    boundary: z.literal("PREPARED_FOR_USE"),
    manifestId: token,
    consumerOperationSlot: token,
    exposureOrdinal: z.string().regex(/^[1-9][0-9]*$/),
    projectionVersion: token,
    declaredVersions: z.array(token).max(32).optional(),
    inputDigest: digest,
    fields: z
      .array(
        z
          .object({
            path: token,
            digest,
            characters: z.number().int().nonnegative(),
            availability: ContextAvailabilitySchema
          })
          .strict()
      )
      .max(4096),
    blocks: z
      .array(
        z
          .object({
            key: token,
            epistemicState: token.optional(),
            state: z.enum(["EXPOSED", "TRUNCATED", "TRANSFORMED", "OMITTED", "UNTRACED_TRANSFORM"]),
            digest: digest.nullable(),
            characters: z.number().int().nonnegative(),
            field: token.nullable(),
            offset: z.number().int().nonnegative().nullable(),
            sourceReferences: z.array(token).max(1024)
          })
          .strict()
      )
      .max(128)
  })
  .strict();
export type ContextExposure = z.infer<typeof ContextExposureSchema>;
/** Text exists only for tracing the current projection, never in a durable manifest. */
export type PendingContextUse = {
  manifest: Omit<
    ContextManifest,
    "namespace" | "executionId" | "assemblyOrdinal" | "scope" | "version"
  >;
  blocks: Array<{
    key: string;
    text: string;
    sourceReferences: string[];
    epistemicState?: string | undefined;
  }>;
  verifyCurrent?: (() => Promise<boolean>) | undefined;
};
