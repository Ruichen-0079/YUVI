import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { JournalRepository, JournalAuthorityDraft } from "@companion/journal";
import type { JournalEventRef } from "@companion/protocol";
import type { AuthorityPool, MemoryReadAuthority } from "@companion/memory";
import { buildMemoryScope, parseMemoryScope } from "@companion/memory";
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
  memoryAllowed?: boolean;
}>;
type RequestIdentity = { headers: Record<string, string | string[] | undefined> };
/** Security admission, not semantic processing. Only a Host-issued bearer grants continuity. */
export class ConversationHostIdentity {
  private readonly authenticated = new WeakSet<object>();
  productCookie?: ((request: RequestIdentity) => Promise<string | undefined>) | undefined;
  constructor(
    private readonly db: AuthorityPool,
    private readonly journal: JournalRepository,
    readonly owner: { instanceId: string; personaId: string },
    private readonly personRevision: (personId: string) => string | null
  ) {}
  personVersion(personId: string) {
    return this.personRevision(personId);
  }
  get namespace() {
    return this.journal.namespace;
  }
  async ownsSource(identity: AuthenticatedConversationHost, ref: JournalEventRef) {
    if (!this.authenticated.has(identity) || ref.namespace !== this.namespace) return false;
    const source = await this.journal.get(ref);
    const a = source?.authority;
    return (
      a?.principal.state === "RESOLVED" &&
      a.principal.actorId === identity.principal.actorId &&
      a.principal.namespace === identity.principal.namespace &&
      a.binding.state === "RESOLVED" &&
      a.binding.personId === identity.personId &&
      a.audience.kind === "PRIVATE"
    );
  }
  async issue(
    personId: string,
    lifetimeSeconds = 86400,
    db: Pick<AuthorityPool, "query"> = this.db
  ) {
    const revision = this.personRevision(personId);
    if (!revision) throw new ConversationHostIdentityError("HOST_PERSON_NOT_VERSIONED");
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 60 || lifetimeSeconds > 2592000)
      throw new ConversationHostIdentityError("HOST_GRANT_LIFETIME_INVALID", 400);
    const grantId = `mhg_${randomUUID()}`;
    const token = `yuh_${randomBytes(32).toString("base64url")}`;
    await db.query(
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
      await db.query(
        `select actor_id from memory_host_principals where journal_namespace=$1 and instance_id=$2 and persona_id=$3 and person_id=$4`,
        [this.journal.namespace, this.owner.instanceId, this.owner.personaId, personId]
      )
    ).rows[0]!;
    const actorId = String(principal["actor_id"]);
    await db.query(
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
  /** Local controller target, never inferred from the session name or model. */
  readTextTarget(personId?: string) {
    const revision = personId ? this.personRevision(personId) : null;
    if (personId && !revision) throw new ConversationHostIdentityError("HOST_PERSON_NOT_VERSIONED");
    return async (ref: JournalEventRef | undefined): Promise<boolean> => {
      if (!ref || ref.namespace !== this.journal.namespace) return false;
      const source = await this.journal.get(ref);
      if (!source) return false;
      if (!personId) return source.authority.binding.state === "UNRESOLVED";
      if (this.personRevision(personId) !== revision) return false;
      return Boolean(
        await this.allowsConversationSource(ref, buildMemoryScope(personId, this.owner.personaId))
      );
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
    const identity = await this.authenticate(request, input);
    await this.claimSession(input.sessionId, identity);
    return identity;
  }
  async authenticate(
    request: RequestIdentity,
    input: { subjectUserId?: string | null | undefined; personaId?: string | null | undefined } = {}
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
    if (
      !this.productCookie &&
      typeof request.headers["cookie"] === "string" &&
      request.headers["cookie"].includes("yuvi_product_host=")
    )
      throw new ConversationHostIdentityError("HOST_PRODUCT_UNAVAILABLE", 401);
    const cookieToken = await this.productCookie?.(request);
    if (token && cookieToken)
      throw new ConversationHostIdentityError("HOST_CREDENTIAL_AMBIGUOUS", 401);
    if (!token) token = cookieToken;
    let identity: AuthenticatedConversationHost | undefined;
    if (token) {
      const row = (
        await this.db.query(
          `select g.*,coalesce(p.memory_enabled,true) as memory_allowed,p.grant_id as product_grant_id from memory_host_grants g left join memory_product_hosts p using(grant_id) where token_hash=$1 and journal_namespace=$2 and instance_id=$3 and persona_id=$4 and revoked_at is null and expires_at>clock_timestamp()`,
          [hash(token), this.journal.namespace, this.owner.instanceId, this.owner.personaId]
        )
      ).rows[0];
      if (
        !row ||
        (row["product_grant_id"] && token !== cookieToken) ||
        row["person_revision"] !== this.personRevision(String(row["person_id"]))
      )
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
        bindingVersion: String(row["grant_id"]),
        memoryAllowed: row["memory_allowed"] === true
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
  /** Serialize accepted ingress with grant revocation; profile text is not an authority generation. */
  async lockCurrentGrant(
    identity: AuthenticatedConversationHost,
    tx: Pick<AuthorityPool, "query">,
    requireMemory = false
  ): Promise<boolean> {
    if (!this.authenticated.has(identity)) return false;
    const row = (
      await tx.query(
        `select person_revision from memory_host_grants
      where grant_id=$1 and actor_id=$2 and person_id=$3 and persona_id=$4 and instance_id=$5 and journal_namespace=$6
        and revoked_at is null and expires_at>clock_timestamp() for share`,
        [
          identity.grantId,
          identity.principal.actorId,
          identity.personId,
          this.owner.personaId,
          this.owner.instanceId,
          this.journal.namespace
        ]
      )
    ).rows[0];
    if (!row || row["person_revision"] !== this.personRevision(identity.personId)) return false;
    const product = (
      await tx.query(
        "select memory_enabled from memory_product_hosts where grant_id=$1 for share",
        [identity.grantId]
      )
    ).rows[0];
    return !requireMemory || !product || product["memory_enabled"] === true;
  }
  /** Conversation text remains usable when long-term Memory is disabled. Revocation still fences both. */
  async allowsConversationSource(
    ref: JournalEventRef | undefined,
    scope: string
  ): Promise<boolean> {
    return Boolean(await this.resolveSourceAuthority(ref, scope, undefined, false));
  }
  async readAuthority(
    ref: JournalEventRef | undefined,
    scope: string,
    transaction?: Pick<AuthorityPool, "query">
  ): Promise<MemoryReadAuthority | undefined> {
    return this.resolveSourceAuthority(ref, scope, transaction, true);
  }
  private async resolveSourceAuthority(
    ref: JournalEventRef | undefined,
    scope: string,
    transaction: Pick<AuthorityPool, "query"> | undefined,
    requireMemory: boolean
  ): Promise<MemoryReadAuthority | undefined> {
    if (!ref || ref.namespace !== this.journal.namespace) return undefined;
    const e = await this.journal.get(ref, transaction);
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
      await (transaction ?? this.db).query(
        `select grant_id,person_revision from memory_host_grants g where grant_id=$1 and actor_id=$2 and person_id=$3 and persona_id=$4 and instance_id=$5 and journal_namespace=$6 and revoked_at is null and expires_at>clock_timestamp()${transaction ? " for share" : ""}`,
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
    const product = row
      ? (
          await (transaction ?? this.db).query(
            `select memory_enabled from memory_product_hosts where grant_id=$1${transaction ? " for share" : ""}`,
            [row["grant_id"]]
          )
        ).rows[0]
      : undefined;
    return row &&
      (!requireMemory || !product || product["memory_enabled"] === true) &&
      row["person_revision"] === this.personRevision(a.binding.personId)
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
