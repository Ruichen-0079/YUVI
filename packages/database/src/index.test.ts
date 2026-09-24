import { describe, expect, it } from "vitest";
import { normalizePostgresConnectionString } from "./index.js";

describe("PostgreSQL connection infrastructure", () => {
  it("keeps the Windows loopback normalization used by existing repositories", () => {
    expect(
      normalizePostgresConnectionString("postgres://user:secret@localhost:5432/yuvi", "win32")
    ).toBe("postgres://user:secret@127.0.0.1:5432/yuvi");
  });

  it("does not rewrite remote hosts or non-Windows connections", () => {
    expect(
      normalizePostgresConnectionString("postgres://user@db.example/yuvi", "win32")
    ).toBe("postgres://user@db.example/yuvi");
    expect(
      normalizePostgresConnectionString("postgres://user@localhost/yuvi", "linux")
    ).toBe("postgres://user@localhost/yuvi");
  });
});
