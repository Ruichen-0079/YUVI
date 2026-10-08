import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { PRIMARY_CHARACTER, defineCharacter } from "@companion/core";
import {
  characterComposition,
  preserveCharacterEnvironment,
  readCharacterComposition
} from "./character-composition.js";
import { claimCharacterFiles } from "./character-storage.js";

const definition = defineCharacter({
  id: "alice",
  revision: "1",
  name: "Alice",
  persona: "Alice owns a private perspective."
});
describe("Character bootstrap and durable file ownership", () => {
  it("snapshots configuration, pins storage and Memory ownership across reload, and separates test/prod instances", () => {
    const env = { LOCAL_MODEL_BASEURL: "http://127.0.0.1:8080/v1", MEMORY_PERSONA_ID: "old" };
    const a = characterComposition({
      binding: { instanceId: "alice.production", definition },
      envDirectory: "/alice-prod",
      env
    });
    const b = characterComposition({
      binding: { instanceId: "alice.testing", definition },
      envDirectory: "/alice-test",
      env
    });
    env.LOCAL_MODEL_BASEURL = "http://changed";
    expect(a.env["LOCAL_MODEL_BASEURL"]).toBe(b.env["LOCAL_MODEL_BASEURL"]);
    expect(a.env["MEMORY_PERSONA_ID"]).not.toBe(b.env["MEMORY_PERSONA_ID"]);
    expect(
      preserveCharacterEnvironment(a, {
        MEMORY_PERSONA_ID: b.env["MEMORY_PERSONA_ID"],
        YUVI_RUNTIME_ENV_DIR: "/retarget"
      })
    ).toMatchObject({
      MEMORY_PERSONA_ID: a.env["MEMORY_PERSONA_ID"],
      YUVI_RUNTIME_ENV_DIR: "/alice-prod"
    });
    expect(Object.isFrozen(a.binding.definition.authoredInvariants)).toBe(true);
  });
  it("adopts existing primary bytes unchanged and rejects a different Character at the same file root", () => {
    const root = mkdtempSync(join(tmpdir(), "yuvi-legacy-character-"));
    const env = { YUVI_RUNTIME_ENV_DIR: root };
    try {
      writeFileSync(join(root, "p8-corrections.json"), "legacy-corrections-byte-marker");
      claimCharacterFiles(PRIMARY_CHARACTER, env, true);
      claimCharacterFiles(PRIMARY_CHARACTER, env, true);
      expect(readFileSync(join(root, "p8-corrections.json"), "utf8")).toBe(
        "legacy-corrections-byte-marker"
      );
      expect(() =>
        claimCharacterFiles({ instanceId: "alice.production", definition }, env, false)
      ).toThrow(/another instance/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("refuses to turn unowned historical files into a new Character's experience", () => {
    const root = mkdtempSync(join(tmpdir(), "yuvi-unknown-character-"));
    try {
      writeFileSync(join(root, "proactive-policy.json"), "historical");
      expect(() =>
        claimCharacterFiles(
          { instanceId: "alice.production", definition },
          { YUVI_RUNTIME_ENV_DIR: root },
          false
        )
      ).toThrow(/historical state/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("loads one bounded authored definition without putting a current Character into process globals", () => {
    const root = mkdtempSync(join(tmpdir(), "yuvi-character-config-"));
    const before = process.env["MEMORY_PERSONA_ID"];
    try {
      const file = join(root, "alice.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          instanceId: "alice.production",
          definition: {
            id: "alice",
            revision: "1",
            name: "Alice",
            persona: "Playful but precise."
          },
          envDirectory: join(root, "state")
        })
      );
      expect(readCharacterComposition(file, {})!.binding.definition.name).toBe("Alice");
      expect(process.env["MEMORY_PERSONA_ID"]).toBe(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("loads the complete versioned Alice authoring through the production bootstrap", () => {
    const root = mkdtempSync(join(tmpdir(), "yuvi-alice-authoring-"));
    const authored = JSON.parse(
      readFileSync(
        new URL("../../../config/characters/alice.definition.json", import.meta.url),
        "utf8"
      )
    );
    try {
      const file = join(root, "alice.json");
      writeFileSync(
        file,
        JSON.stringify({
          version: 1,
          instanceId: "alice.test",
          definition: authored,
          envDirectory: join(root, "state")
        })
      );
      const loaded = readCharacterComposition(file, {})!.binding.definition;
      expect(loaded.aliases).toEqual(authored.aliases);
      expect(loaded.responseRequirements).toEqual(authored.responseRequirements);
      expect(
        loaded.authoredInvariants
          .filter((v) => v.target === "persona")
          .map((v) => v.statement)
          .join("")
      ).toBe(authored.persona);
      expect(loaded.authoredInvariants.some((v) => v.statement === authored.identity)).toBe(true);
      expect(JSON.stringify(loaded)).not.toContain("主人");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
