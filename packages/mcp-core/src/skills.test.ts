import { describe, expect, it } from "vitest";
import skillDefinitions from "./skillDefinitions";
import {
  ACTIVE_SKILLS,
  DEFAULT_SKILLS,
  isEnabledBySkills,
  isValidSkill,
  parseSkills,
  SKILLS,
  type Skill,
} from "./skills";
import toolDefinitions from "./toolDefinitions";

function getGeneratedSkillToolNames(skillId: string) {
  const skill = skillDefinitions.find(
    (definition) => definition.id === skillId,
  );
  expect(skill).toBeDefined();

  return new Set(skill?.tools?.map((definition) => definition.name) ?? []);
}

function getGeneratedSkillToolDescription(skillId: string, toolName: string) {
  const skill = skillDefinitions.find(
    (definition) => definition.id === skillId,
  );
  expect(skill).toBeDefined();

  const tool = skill?.tools?.find((definition) => definition.name === toolName);
  expect(tool).toBeDefined();

  return tool?.description ?? "";
}

describe("skills module", () => {
  it.each([
    ["api-read", "disabled"],
    ["api-write", "enabled"],
  ])("describes hosted Code Mode access for %s", (skillId, writeState) => {
    const definition = skillDefinitions.find((skill) => skill.id === skillId);
    expect(definition?.hostedOnly).toBe(true);
    expect([...getGeneratedSkillToolNames(skillId)]).toEqual(
      expect.arrayContaining(["search_sentry_api", "execute_sentry_code"]),
    );
    expect(definition?.toolCount).toBe(definition?.tools?.length);
    expect(
      getGeneratedSkillToolDescription(skillId, "execute_sentry_code"),
    ).toContain(`Writes are ${writeState}.`);
    expect(toolDefinitions.map((tool) => tool.name)).not.toContain(
      "execute_sentry_code",
    );
  });

  it("does not advertise workflow-only tools in generated skill prompts", () => {
    for (const skill of skillDefinitions) {
      expect(skill.tools?.map((tool) => tool.name) ?? []).not.toContain(
        "onboarding_status_update",
      );
    }
  });

  describe("SKILLS registry", () => {
    it("has all expected skills", () => {
      expect(SKILLS.inspect).toBeDefined();
      expect(SKILLS.triage).toBeDefined();
      expect(SKILLS["project-management"]).toBeDefined();
      expect(SKILLS.seer).toBeDefined();
      expect(SKILLS.docs).toBeDefined();
      expect(SKILLS["api-read"].hostedOnly).toBe(true);
      expect(SKILLS["api-write"].hostedOnly).toBe(true);
      expect("preprod" in SKILLS).toBe(false);
    });

    it("includes metadata for each skill", () => {
      for (const skill of Object.values(SKILLS)) {
        expect(skill.id).toBeTruthy();
        expect(skill.name).toBeTruthy();
        expect(skill.description).toBeTruthy();
        expect(typeof skill.defaultEnabled).toBe("boolean");
        expect(typeof skill.order).toBe("number");
      }
    });

    it("marks docs as a deprecated legacy skill", () => {
      expect(SKILLS.docs.deprecated).toBe(true);
    });
  });

  describe("DEFAULT_SKILLS", () => {
    it("includes only default-enabled skills", () => {
      expect(DEFAULT_SKILLS).toContain("inspect");
      expect(DEFAULT_SKILLS).toContain("seer");
      expect(DEFAULT_SKILLS).not.toContain("docs");
      expect(DEFAULT_SKILLS).not.toContain("triage");
      expect(DEFAULT_SKILLS).not.toContain("project-management");
      expect(DEFAULT_SKILLS).not.toContain("api-read");
      expect(DEFAULT_SKILLS).not.toContain("api-write");
    });

    it("has exactly 2 default skills", () => {
      expect(DEFAULT_SKILLS.length).toBe(2);
    });
  });

  describe("ACTIVE_SKILLS", () => {
    it("excludes deprecated legacy skills", () => {
      expect(ACTIVE_SKILLS).toEqual([
        "inspect",
        "seer",
        "triage",
        "project-management",
        "api-read",
        "api-write",
      ]);
      expect(ACTIVE_SKILLS).not.toContain("docs");
    });
  });

  describe("isValidSkill", () => {
    it("returns true for valid skills", () => {
      expect(isValidSkill("inspect")).toBe(true);
      expect(isValidSkill("triage")).toBe(true);
      expect(isValidSkill("project-management")).toBe(true);
      expect(isValidSkill("seer")).toBe(true);
      expect(isValidSkill("docs")).toBe(true);
      expect(isValidSkill("api-read")).toBe(true);
      expect(isValidSkill("api-write")).toBe(true);
    });

    it("returns false for invalid skills", () => {
      expect(isValidSkill("invalid")).toBe(false);
      expect(isValidSkill("")).toBe(false);
      expect(isValidSkill("INSPECT")).toBe(false);
      expect(isValidSkill("preprod")).toBe(false);
      expect(isValidSkill("toString")).toBe(false);
    });
  });

  describe("parseSkills", () => {
    it("keeps existing grants unchanged when API capabilities are introduced", () => {
      expect(parseSkills(["inspect", "triage"]).valid).toEqual(
        new Set(["inspect", "triage"]),
      );
      expect(parseSkills(["api-write"]).valid).toEqual(new Set(["api-write"]));
    });
    it("parses comma-separated string", () => {
      const { valid, invalid } = parseSkills("inspect,triage,docs");
      expect(valid.size).toBe(3);
      expect(valid.has("inspect")).toBe(true);
      expect(valid.has("triage")).toBe(true);
      expect(valid.has("docs")).toBe(true);
      expect(invalid.length).toBe(0);
    });

    it("parses array of skills", () => {
      const { valid, invalid } = parseSkills(["inspect", "triage"]);
      expect(valid.size).toBe(2);
      expect(valid.has("inspect")).toBe(true);
      expect(valid.has("triage")).toBe(true);
      expect(invalid.length).toBe(0);
    });

    it("separates valid and invalid skills", () => {
      const { valid, invalid } = parseSkills(
        "inspect,invalid1,triage,invalid2",
      );
      expect(valid.size).toBe(2);
      expect(valid.has("inspect")).toBe(true);
      expect(valid.has("triage")).toBe(true);
      expect(invalid).toEqual(["invalid1", "invalid2"]);
    });

    it("trims whitespace from skills", () => {
      const { valid, invalid } = parseSkills(" inspect , triage , docs ");
      expect(valid.size).toBe(3);
      expect(valid.has("inspect")).toBe(true);
      expect(invalid.length).toBe(0);
    });

    it("handles empty input", () => {
      const { valid, invalid } = parseSkills("");
      expect(valid.size).toBe(0);
      expect(invalid.length).toBe(0);
    });

    it("handles null/undefined input", () => {
      const { valid, invalid } = parseSkills(null);
      expect(valid.size).toBe(0);
      expect(invalid.length).toBe(0);
    });

    it("ignores empty strings in array", () => {
      const { valid, invalid } = parseSkills(["inspect", "", "triage"]);
      expect(valid.size).toBe(2);
      expect(invalid.length).toBe(0);
    });

    it("treats legacy preprod skill as invalid by default", () => {
      const { valid, invalid } = parseSkills(["preprod"]);
      expect(valid).toEqual(new Set());
      expect(invalid).toEqual(["preprod"]);
    });

    it("does not treat object prototype properties as skills", () => {
      const { valid, invalid } = parseSkills(["toString"]);
      expect(valid).toEqual(new Set());
      expect(invalid).toEqual(["toString"]);
    });
  });

  describe("isEnabledBySkills", () => {
    it("returns true when any tool skill is granted", () => {
      const grantedSkills = new Set<Skill>(["inspect", "docs"]);
      expect(isEnabledBySkills(grantedSkills, ["inspect"])).toBe(true);
      expect(isEnabledBySkills(grantedSkills, ["docs"])).toBe(true);
      expect(isEnabledBySkills(grantedSkills, ["inspect", "triage"])).toBe(
        true,
      );
    });

    it("returns false when no tool skills are granted", () => {
      const grantedSkills = new Set<Skill>(["inspect", "docs"]);
      expect(isEnabledBySkills(grantedSkills, ["triage"])).toBe(false);
      expect(
        isEnabledBySkills(grantedSkills, ["triage", "project-management"]),
      ).toBe(false);
    });

    it("returns false when grantedSkills is undefined", () => {
      expect(isEnabledBySkills(undefined, ["inspect"])).toBe(false);
    });

    it("returns false when toolSkills is empty", () => {
      const grantedSkills = new Set<Skill>(["inspect"]);
      expect(isEnabledBySkills(grantedSkills, [])).toBe(false);
    });
  });

  describe("generated skill definitions", () => {
    it("lists tools for each skill", () => {
      const inspectToolNames = getGeneratedSkillToolNames("inspect");
      const triageToolNames = getGeneratedSkillToolNames("triage");

      expect(inspectToolNames).toContain("get_snapshot_image");
      expect(triageToolNames).not.toContain("get_snapshot_image");
    });

    it("omits monitor resource guidance when the inspect skill is not enabled", () => {
      const inspectDescription = getGeneratedSkillToolDescription(
        "inspect",
        "get_sentry_resource",
      );
      const triageDescription = getGeneratedSkillToolDescription(
        "triage",
        "get_sentry_resource",
      );

      expect(inspectDescription).toContain("monitors");
      expect(inspectDescription).toContain("- monitor: <monitorSlug>");

      expect(triageDescription).not.toContain("monitors");
      expect(triageDescription).not.toContain("- monitor: <monitorSlug>");
    });
  });
});
