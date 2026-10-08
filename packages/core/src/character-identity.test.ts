import { describe, expect, it } from "vitest";
import { defineCharacter } from "./character-identity.js";

describe("authored Character identity and expression ownership", () => {
  it("projects biography into Identity, keeps behavioral Persona complete, and snapshots surface expression independently", () => {
    const aliases = ["爱丽丝", "Alice"];
    const responseRequirements = {
      general: "认真完成任务",
      group: "群聊自然短答",
      private: "私聊耐心"
    };
    const definition = defineCharacter({
      id: "alice",
      revision: "2",
      name: "爱丽丝",
      identity: "魔法森林的魔法使与人偶师。",
      persona: "习惯先观察再判断，独立且不服输；关心通过具体帮助表达。",
      aliases,
      responseRequirements
    });
    aliases.push("other");
    responseRequirements.group = "changed";
    expect(definition.aliases).toEqual(["爱丽丝", "Alice"]);
    expect(definition.responseRequirements?.group).toBe("群聊自然短答");
    expect(Object.isFrozen(definition.responseRequirements)).toBe(true);
    expect(
      definition.authoredInvariants
        .filter((v) => v.target === "identity")
        .map((v) => v.statement)
        .join("\n")
    ).toContain("魔法森林");
    expect(
      definition.authoredInvariants
        .filter((v) => v.target === "persona")
        .map((v) => v.statement)
        .join("")
    ).toBe("习惯先观察再判断，独立且不服输；关心通过具体帮助表达。");
    expect(JSON.stringify(definition.authoredInvariants)).not.toContain("群聊自然短答");
    expect(definition.systemIdentity).not.toContain("AI companion");
  });
  it("rejects unbounded or unknown expression fields and invalid aliases at authoring", () => {
    const base = { id: "alice", revision: "2", name: "Alice", persona: "Independent." };
    expect(() => defineCharacter({ ...base, aliases: [" "] })).toThrow();
    expect(() =>
      defineCharacter({ ...base, responseRequirements: { general: "x".repeat(4001) } })
    ).toThrow();
    expect(() =>
      defineCharacter({
        ...base,
        responseRequirements: { general: "Style", mood: "fixed" } as never
      })
    ).toThrow();
  });
});
