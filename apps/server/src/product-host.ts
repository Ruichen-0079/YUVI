import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { AuthorityPool, AuthorityQuery } from "@companion/memory";
import {
  ConversationHostIdentity,
  ConversationHostIdentityError
} from "./conversation-host-identity.js";

type Request = { ip?: string; headers: Record<string, string | string[] | undefined> };
const COOKIE = "yuvi_product_host";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const denied = () => new ConversationHostIdentityError("PRODUCT_HOST_UNAUTHORIZED", 401);
function webOrigin(value: unknown): string {
  if (typeof value !== "string") throw denied();
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw denied();
  }
  if (
    u.origin !== value ||
    !["http:", "https:"].includes(u.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)
  )
    throw denied();
  return value;
}
function requestOrigin(r: Request) {
  const value = r.headers["origin"];
  if (typeof value === "string") return webOrigin(value);
  const referer = r.headers["referer"];
  if (typeof referer === "string") {
    try {
      return webOrigin(new URL(referer).origin);
    } catch {
      throw denied();
    }
  }
  throw denied();
}
/** Local-controller ceremony and browser credential lifecycle. No operator credential
 * or conversational bearer is exposed to JavaScript. Remote WebUI is not enrolled. */
export class ProductHost {
  constructor(
    readonly db: AuthorityPool,
    readonly host: ConversationHostIdentity,
    private readonly controller: string
  ) {
    host.productCookie = (r) => this.cookie(r);
  }
  isController(r: Request): boolean {
    const provided = r.headers["authorization"];
    const expected = "Bearer " + this.controller;
    return (
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(r.ip ?? "") &&
      r.headers["origin"] === undefined &&
      r.headers["referer"] === undefined &&
      r.headers["sec-fetch-site"] === undefined &&
      typeof provided === "string" &&
      Buffer.byteLength(provided) === Buffer.byteLength(expected) &&
      timingSafeEqual(Buffer.from(provided), Buffer.from(expected))
    );
  }
  async createPairing(personId: string, origin: string) {
    origin = webOrigin(origin);
    if (!this.host.personVersion(personId)) throw denied();
    const code = "yup_" + randomBytes(32).toString("base64url");
    await this.db.query(
      `insert into memory_product_pairings(code_hash,journal_namespace,instance_id,persona_id,person_id,person_revision,web_origin,expires_at) values($1,$2,$3,$4,$5,$6,$7,now()+interval '5 minutes')`,
      [
        digest(code),
        this.hostNamespace,
        this.host.owner.instanceId,
        this.host.owner.personaId,
        personId,
        this.host.personVersion(personId),
        origin
      ]
    );
    return { schema: "host.product-pairing.v1", code, origin, expiresInSeconds: 300 };
  }
  // The Host's principal namespace is authoritative, never supplied by a browser.
  get hostNamespace() {
    return this.host.namespace;
  }
  async pair(r: Request, code: string) {
    const origin = requestOrigin(r);
    const oldToken = await this.cookie(r).catch((error: unknown) => {
      if (error instanceof ConversationHostIdentityError) return undefined;
      throw error;
    });
    return this.transaction(async (tx) => {
      const row = (
        await tx.query(
          `select * from memory_product_pairings where code_hash=$1 and journal_namespace=$2 and instance_id=$3 and persona_id=$4 and web_origin=$5 and consumed_at is null and expires_at>clock_timestamp() for update`,
          [
            digest(code),
            this.hostNamespace,
            this.host.owner.instanceId,
            this.host.owner.personaId,
            origin
          ]
        )
      ).rows[0];
      if (!row || row["person_revision"] !== this.host.personVersion(String(row["person_id"])))
        throw denied();
      if (oldToken)
        await tx.query(
          "update memory_host_grants set revoked_at=coalesce(revoked_at,clock_timestamp()) where token_hash=$1",
          [digest(oldToken)]
        );
      const grant = await this.host.issue(String(row["person_id"]), 86400, tx);
      await tx.query(
        `insert into memory_product_hosts(grant_id,web_origin,renew_until) values($1,$2,now()+interval '30 days')`,
        [grant.grantId, origin]
      );
      await tx.query("update memory_product_pairings set consumed_at=now() where code_hash=$1", [
        digest(code)
      ]);
      return {
        grant,
        cookie: productCookie(grant.token, origin, 2592000)
      };
    });
  }
  async cookie(r: Request): Promise<string | undefined> {
    const header = r.headers["cookie"];
    if (typeof header !== "string") return undefined;
    const parts = header
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.startsWith(COOKIE + "="));
    if (!parts.length) return undefined;
    if (parts.length !== 1) throw denied();
    const token = parts[0]!.slice(COOKIE.length + 1);
    if (!/^yuh_[A-Za-z0-9_-]{43}$/u.test(token)) throw denied();
    const row = (
      await this.db.query(
        `select p.web_origin from memory_product_hosts p join memory_host_grants g using(grant_id) where g.token_hash=$1 and g.journal_namespace=$2 and g.instance_id=$3 and g.persona_id=$4`,
        [digest(token), this.hostNamespace, this.host.owner.instanceId, this.host.owner.personaId]
      )
    ).rows[0];
    if (!row || row["web_origin"] !== requestOrigin(r)) throw denied();
    return token;
  }
  async state(
    r: Request,
    action: "status" | "renew" | "revoke" | "memory" = "status",
    enabled?: boolean
  ) {
    const token = await this.cookie(r);
    if (!token) throw denied();
    return this.transaction(async (tx) => {
      let cookie: string | undefined;
      const row = (
        await tx.query(
          `select g.*,p.web_origin,p.memory_enabled,p.renew_until from memory_host_grants g join memory_product_hosts p using(grant_id) where g.token_hash=$1 and g.revoked_at is null for update of g,p`,
          [digest(token)]
        )
      ).rows[0];
      if (
        !row ||
        row["person_revision"] !== this.host.personVersion(String(row["person_id"])) ||
        new Date(row["renew_until"]).getTime() <= Date.now()
      )
        throw denied();
      if (action === "revoke")
        await tx.query(
          "update memory_host_grants set revoked_at=clock_timestamp() where grant_id=$1",
          [row["grant_id"]]
        );
      if (action === "renew") {
        const rotated = `yuh_${randomBytes(32).toString("base64url")}`;
        const renewed = (
          await tx.query(
            "update memory_host_grants set token_hash=$3, expires_at=least($2::timestamptz,clock_timestamp()+interval '1 day') where grant_id=$1 returning expires_at",
            [row["grant_id"], row["renew_until"], digest(rotated)]
          )
        ).rows[0]!;
        row["expires_at"] = renewed["expires_at"];
        cookie = productCookie(
          rotated,
          String(row["web_origin"]),
          Math.max(1, Math.floor((new Date(row["renew_until"]).getTime() - Date.now()) / 1000))
        );
      }
      if (action === "memory") {
        if (new Date(row["expires_at"]).getTime() <= Date.now()) throw denied();
        await tx.query("update memory_product_hosts set memory_enabled=$2 where grant_id=$1", [
          row["grant_id"],
          enabled
        ]);
        row["memory_enabled"] = enabled;
      }
      return {
        ...(cookie ? { cookie } : {}),
        schema: "host.product.v1" as const,
        status:
          action === "revoke"
            ? "REVOKED"
            : new Date(row["expires_at"]).getTime() <= Date.now()
              ? "EXPIRED"
              : "ACTIVE",
        personId: String(row["person_id"]),
        personaId: this.host.owner.personaId,
        memoryEnabled: row["memory_enabled"] === true,
        expiresAt: new Date(row["expires_at"]).toISOString(),
        renewalUntil: new Date(row["renew_until"]).toISOString()
      };
    });
  }
  private async transaction<T>(work: (tx: AuthorityQuery) => Promise<T>) {
    const tx = await this.db.connect();
    let connectionError: Error | undefined;
    const ignore = (error: Error) => {
      connectionError = error;
    };
    tx.on?.("error", ignore);
    try {
      await tx.query("begin");
      const result = await work(tx);
      if (connectionError) throw connectionError;
      await tx.query("commit");
      return result;
    } catch (e) {
      await tx.query("rollback").catch(() => undefined);
      throw e;
    } finally {
      tx.off?.("error", ignore);
      tx.release();
    }
  }
}

function productCookie(token: string, origin: string, seconds: number) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${seconds}${origin.startsWith("https:") ? "; Secure" : ""}`;
}
