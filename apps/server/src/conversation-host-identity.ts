import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JournalRepository, JournalAuthorityDraft } from "@companion/journal";
import type { JournalEventRef } from "@companion/protocol";
import type { AuthorityPool, MemoryReadAuthority } from "@companion/memory";
import { parseMemoryScope } from "@companion/memory";
import { isDesktopAllowedOrigin } from "./cors.js";

export class ConversationHostIdentityError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode = 403
  ) {
    super(code);
  }
}
export type AuthenticatedConversationHost = Readonly<{
  grantId: string;
  principal: { state: "RESOLVED"; kind: "PRINCIPAL"; namespace: string; actorId: string };
  personId: string;
  personaId: string;
  bindingVersion: string;
}>;
type RequestIdentity = { headers: Record<string, string | string[] | undefined> };
/** Security admission, not semantic processing. Only a Host-issued bearer grants continuity. */
export class ConversationHostIdentity {
  private readonly authenticated = new WeakSet<object>();
  constructor(
    private readonly db: AuthorityPool,
    private readonly journal: JournalRepository,
    readonly owner: { instanceId: string; personaId: string },
    private readonly personRevision: (personId: string) => string | null
  ) {}
  async issue(personId: string, lifetimeSeconds = 86400) {
    const revision = this.personRevision(personId);
    if (!revision) throw new ConversationHostIdentityError("HOST_PERSON_NOT_VERSIONED");
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 2592000)
      throw new ConversationHostIdentityError("HOST_GRANT_LIFETIME_INVALID", 400);
    const grantId = `mhg_${randomUUID()}`;
    const token = `yuh_${randomBytes(32).toString("base64url")}`;
    await this.db.query(
      `insert into memory_host_principals(journal_namespace,instance_id,persona_id,person_id,actor_id) values($1,$2,$3,$4,$5) on conflict do nothing`,
      [
        this.journal.namespace,
        this.owner.instanceId,
        this.owner.personaId,
        personId,
        `http_${randomUUID()}`
      ]
    );
    const principal = (
      await this.db.query(
        `select actor_id from memory_host_principals where journal_namespace=$1 and instance_id=$2 and persona_id=$3 and person_id=$4`,
        [this.journal.namespace, this.owner.instanceId, this.owner.personaId, personId]
      )
    ).rows[0]!;
    const actorId = String(principal["actor_id"]);
    await this.db.query(
      `insert into memory_host_grants(grant_id,token_hash,journal_namespace,instance_id,persona_id,person_id,person_revision,actor_id,expires_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,now()+$9*interval '1 second')`,
      [
        grantId,
        hash(token),
        this.journal.namespace,
        this.owner.instanceId,
        this.owner.personaId,
        personId,
        revision,
        actorId,
        lifetimeSeconds
      ]
    );
    return {
      schema: "host.grant.v1" as const,
      grantId,
      token,
      personId,
      personaId: this.owner.personaId,
      lifetimeSeconds
    };
  }
  async revoke(grantId: string) {
    const r = await this.db.query(
      `update memory_host_grants set revoked_at=coalesce(revoked_at,now()) where grant_id=$1 and journal_namespace=$2 and instance_id=$3 and persona_id=$4 returning grant_id`,
      [grantId, this.journal.namespace, this.owner.instanceId, this.owner.personaId]
    );
    return {
      schema: "host.grant.revocation.v1" as const,
      status: r.rows.length ? "REVOKED" : "UNKNOWN"
    };
  }
  async authorize(
    request: RequestIdentity,
    input: {
      sessionId: string;
      subjectUserId?: string | null | undefined;
      personaId?: string | null | undefined;
    }
  ): Promise<AuthenticatedConversationHost | undefined> {
    const origin = request.headers["origin"];
    if (origin !== undefined && (typeof origin !== "string" || !isDesktopAllowedOrigin(origin)))
      throw new ConversationHostIdentityError("HOST_ORIGIN_FORBIDDEN");
    const auth = request.headers["authorization"];
    const protocols = request.headers["sec-websocket-protocol"];
    const candidates = (typeof protocols === "string" ? protocols.split(",") : [])
      .map((x) => x.trim())
      .filter((x) => x.startsWith("yuvi-host-token."));
    let token =
      typeof auth === "string" ? auth.match(/^Bearer (yuh_[A-Za-z0-9_-]{43})$/u)?.[1] : undefined;
    if (candidates.length) {
      if (token || candidates.length !== 1)
        throw new ConversationHostIdentityError("HOST_CREDENTIAL_INVALID", 401);
      const encoded = candidates[0]!.slice("yuvi-host-token.".length);
      if (encoded.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(encoded))
        throw new ConversationHostIdentityError("HOST_CREDENTIAL_INVALID", 401);
      const decoded = Buffer.from(encoded, "base64url");
      if (decoded.toString("base64url") !== encoded)
        throw new ConversationHostIdentityError("HOST_CREDENTIAL_INVALID", 401);
      token = decoded.toString("utf8");
    }
    // A dashboard credential is not a Person identity. A malformed Host token is never anonymous.
    if (!token && typeof auth === "string" && auth.includes("yuh_"))
      throw new ConversationHostIdentityError("HOST_CREDENTIAL_INVALID", 401);
    let identity: AuthenticatedConversationHost | undefined;
    if (token) {
      const row = (
        await this.db.query(
          `select * from memory_host_grants where token_hash=$1 and journal_namespace=$2 and instance_id=$3 and persona_id=$4 and revoked_at is null and expires_at>now()`,
          [hash(token), this.journal.namespace, this.owner.instanceId, this.owner.personaId]
        )
      ).rows[0];
      if (!row || row["person_revision"] !== this.personRevision(String(row["person_id"])))
        throw new ConversationHostIdentityError("HOST_CREDENTIAL_INVALID", 401);
      identity = Object.freeze({
        grantId: String(row["grant_id"]),
        principal: {
          state: "RESOLVED" as const,
          kind: "PRINCIPAL" as const,
          namespace: this.journal.namespace,
          actorId: String(row["actor_id"])
        },
        personId: String(row["person_id"]),
        personaId: this.owner.personaId,
        bindingVersion: String(row["grant_id"])
      });
      this.authenticated.add(identity);
      if (
        (input.subjectUserId && input.subjectUserId !== identity.personId) ||
        (input.personaId && input.personaId !== identity.personaId)
      )
        throw new ConversationHostIdentityError("HOST_IDENTITY_OVERRIDE_FORBIDDEN");
    } else if (input.personaId && input.personaId !== this.owner.personaId) {
      throw new ConversationHostIdentityError("HOST_PERSONA_FORBIDDEN");
    }
    await this.claimSession(input.sessionId, identity);
    return identity;
  }
  private async claimSession(sessionId: string, identity?: AuthenticatedConversationHost) {
    const tx = await this.db.connect();
    const onError = () => undefined;
    tx.on?.("error", onError);
    try {
      await tx.query("begin");
      // A unique row fences concurrent first use. Legacy history cannot silently acquire a new owner.
      await tx.query(
        `insert into memory_host_sessions(journal_namespace,persona_id,session_id,actor_id,person_id)
        select $1,$2,$3,case when exists(select 1 from conversation_messages where session_id=$3 limit 1) then null else $4::text end,
        case when exists(select 1 from conversation_messages where session_id=$3 limit 1) then null else $5::text end on conflict do nothing`,
        [
          this.journal.namespace,
          this.owner.personaId,
          sessionId,
          identity?.principal.actorId ?? null,
          identity?.personId ?? null
        ]
      );
      const row = (
        await tx.query(
          `select * from memory_host_sessions where journal_namespace=$1 and session_id=$2 for update`,
          [this.journal.namespace, sessionId]
        )
      ).rows[0]!;
      if (
        row["journal_namespace"] !== this.journal.namespace ||
        row["persona_id"] !== this.owner.personaId ||
        (row["actor_id"] ?? null) !== (identity?.principal.actorId ?? null) ||
        (row["person_id"] ?? null) !== (identity?.personId ?? null)
      )
        throw new ConversationHostIdentityError("HOST_SESSION_OWNER_CONFLICT", 409);
      await tx.query("commit");
    } catch (e) {
      await tx.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      tx.off?.("error", onError);
      tx.release();
    }
  }
  authority(
    identity: AuthenticatedConversationHost
  ): Pick<
    JournalAuthorityDraft,
    "principal" | "subjects" | "binding" | "audience" | "disclosurePolicy"
  > {
    if (!this.authenticated.has(identity))
      throw new ConversationHostIdentityError("HOST_IDENTITY_NOT_ADMITTED");
    return {
      principal: identity.principal,
      subjects: [{ kind: "PERSON", personId: identity.personId, resolution: "RESOLVED" }],
      binding: {
        state: "RESOLVED",
        kind: "PERSON_BINDING",
        personId: identity.personId,
        bindingVersion: identity.bindingVersion
      },
      audience: {
        kind: "PRIVATE",
        channelRef: `host-private:${identity.personId}:${identity.personaId}`
      },
      disclosurePolicy: {
        state: "KNOWN",
        reference: `host-grant:${identity.grantId}`,
        version: "host.private.v1"
      }
    };
  }
  async readAuthority(
    ref: JournalEventRef | undefined,
    scope: string
  ): Promise<MemoryReadAuthority | undefined> {
    if (!ref || ref.namespace !== this.journal.namespace) return undefined;
    const e = await this.journal.get(ref);
    const a = e?.authority;
    if (
      !a ||
      a.principal.state !== "RESOLVED" ||
      a.binding.state !== "RESOLVED" ||
      a.audience.kind !== "PRIVATE" ||
      a.disclosurePolicy.state !== "KNOWN"
    )
      return undefined;
    const parts = parseMemoryScope(scope);
    if (parts.userId !== a.binding.personId || parts.characterId !== this.owner.personaId)
      return undefined;
    const row = (
      await this.db.query(
        `select grant_id,person_revision from memory_host_grants where grant_id=$1 and actor_id=$2 and person_id=$3 and persona_id=$4 and instance_id=$5 and journal_namespace=$6 and revoked_at is null and expires_at>now()`,
        [
          a.binding.bindingVersion,
          a.principal.actorId,
          a.binding.personId,
          this.owner.personaId,
          this.owner.instanceId,
          this.journal.namespace
        ]
      )
    ).rows[0];
    return row && row["person_revision"] === this.personRevision(a.binding.personId)
      ? {
          principal: { namespace: a.principal.namespace, actorId: a.principal.actorId },
          personId: a.binding.personId
        }
      : undefined;
  }
}
function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
