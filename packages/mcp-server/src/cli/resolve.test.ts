import { describe, it, expect } from "vitest";
import { finalize } from "./resolve";

describe("cli/finalize", () => {
  it("returns undefined accessToken when none provided", () => {
    const cfg = finalize({ unknownArgs: [] } as any);
    expect(cfg.accessToken).toBeUndefined();
  });

  it("uses DEFAULT_SENTRY_CLIENT_ID when no clientId provided", () => {
    const cfg = finalize({ accessToken: "tok", unknownArgs: [] });
    expect(cfg.clientId).toBeDefined();
    expect(typeof cfg.clientId).toBe("string");
  });

  it("uses provided clientId over default", () => {
    const cfg = finalize({
      accessToken: "tok",
      clientId: "custom-client-id",
      unknownArgs: [],
    });
    expect(cfg.clientId).toBe("custom-client-id");
  });

  it("normalizes host from URL", () => {
    const cfg = finalize({
      accessToken: "tok",
      url: "https://sentry.example.com",
      unknownArgs: [],
    });
    expect(cfg.sentryHost).toBe("sentry.example.com");
    expect(cfg.sentryProtocol).toBe("https");
  });

  it("uses http protocol for self-hosted hosts when --insecure-http is enabled", () => {
    const cfg = finalize({
      accessToken: "tok",
      host: "sentry.internal:9000",
      insecureHttp: true,
      unknownArgs: [],
    });
    expect(cfg.sentryHost).toBe("sentry.internal:9000");
    expect(cfg.sentryProtocol).toBe("http");
  });

  it("accepts valid OpenAI base URL", () => {
    const cfg = finalize({
      accessToken: "tok",
      openaiBaseUrl: "https://api.proxy.example/v1",
      unknownArgs: [],
    });
    expect(cfg.openaiBaseUrl).toBe(
      new URL("https://api.proxy.example/v1").toString(),
    );
  });

  it("rejects invalid OpenAI base URL", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        openaiBaseUrl: "ftp://example.com",
        unknownArgs: [],
      }),
    ).toThrow(/OPENAI base URL must use http or https scheme/);
  });

  it("accepts azure-openai as a valid explicit provider", () => {
    const cfg = finalize({
      accessToken: "tok",
      agentProvider: "azure-openai",
      unknownArgs: [],
    });
    expect(cfg.agentProvider).toBe("azure-openai");
  });

  it("accepts openrouter as a valid explicit provider", () => {
    const cfg = finalize({
      accessToken: "tok",
      agentProvider: "openrouter",
      unknownArgs: [],
    });
    expect(cfg.agentProvider).toBe("openrouter");
  });

  it("rejects invalid explicit provider values", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        agentProvider: "bad-provider",
        unknownArgs: [],
      }),
    ).toThrow(/Must be "openai", "azure-openai", "anthropic", or "openrouter"/);
  });

  it("throws on non-https URL", () => {
    expect(() =>
      finalize({ accessToken: "tok", url: "http://bad", unknownArgs: [] }),
    ).toThrow(/must be a full HTTPS URL/);
  });

  it("throws when --insecure-http is used with --url", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        url: "https://sentry.example.com",
        insecureHttp: true,
        unknownArgs: [],
      }),
    ).toThrow(/cannot be used with --url or SENTRY_URL/);
  });

  it("surfaces the --insecure-http + --url conflict before URL validation", () => {
    // Even with a non-HTTPS --url, the --insecure-http conflict should win
    // so the user gets the actionable guidance rather than the generic
    // "must be a full HTTPS URL" error.
    expect(() =>
      finalize({
        accessToken: "tok",
        url: "http://sentry.internal:9000",
        insecureHttp: true,
        unknownArgs: [],
      }),
    ).toThrow(/cannot be used with --url or SENTRY_URL/);
  });

  it.each(["sentry.io", "example.my.sentry.io"])(
    "throws when --insecure-http targets %s",
    (host) => {
      expect(() =>
        finalize({
          accessToken: "tok",
          host,
          insecureHttp: true,
          unknownArgs: [],
        }),
      ).toThrow(/only supported for self-hosted Sentry hosts/);
    },
  );

  // Skills tests
  it("throws on invalid skills", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        skills: "invalid-skill",
        unknownArgs: [],
      }),
    ).toThrow(/Invalid skills provided: invalid-skill/);
  });

  it("validates multiple skills and reports all invalid ones", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        skills: "inspect,invalid1,triage,invalid2",
        unknownArgs: [],
      }),
    ).toThrow(/Invalid skills provided: invalid1, invalid2/);
  });

  it("resolves valid skills in override mode (--skills)", () => {
    const cfg = finalize({
      accessToken: "tok",
      skills: "inspect,triage",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("inspect")).toBe(true);
    expect(cfg.finalSkills.has("triage")).toBe(true);
    expect(cfg.finalSkills.size).toBe(2);
    // Should not include defaults
    expect(cfg.finalSkills.has("docs")).toBe(false);
  });

  it("allows explicit legacy docs skill grants", () => {
    const cfg = finalize({
      accessToken: "tok",
      skills: "docs",
      unknownArgs: [],
    });
    expect(cfg.finalSkills).toEqual(new Set(["docs"]));
  });

  it("throws on legacy preprod skill in stdio", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        skills: "preprod",
        unknownArgs: [],
      }),
    ).toThrow(/Invalid skills provided: preprod/);
  });

  it("throws on empty skills after validation", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        skills: "invalid1,invalid2",
        unknownArgs: [],
      }),
    ).toThrow(/Invalid skills provided/);
  });

  it("grants all active skills when no skills specified", () => {
    const cfg = finalize({
      accessToken: "tok",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.size).toBe(4);
    expect(cfg.finalSkills.has("inspect")).toBe(true);
    expect(cfg.finalSkills.has("triage")).toBe(true);
    expect(cfg.finalSkills.has("project-management")).toBe(true);
    expect(cfg.finalSkills.has("seer")).toBe(true);
    expect(cfg.finalSkills.has("docs")).toBe(false);
    expect(cfg.finalSkills.has("preprod")).toBe(false);
  });

  it("grants all active skills with --all-skills", () => {
    const cfg = finalize({
      accessToken: "tok",
      allSkills: true,
      unknownArgs: [],
    });
    expect(cfg.finalSkills.size).toBe(4);
    expect(cfg.finalSkills.has("inspect")).toBe(true);
    expect(cfg.finalSkills.has("triage")).toBe(true);
    expect(cfg.finalSkills.has("project-management")).toBe(true);
    expect(cfg.finalSkills.has("seer")).toBe(true);
    expect(cfg.finalSkills.has("docs")).toBe(false);
    expect(cfg.finalSkills.has("preprod")).toBe(false);
  });

  // Self-hosted defaults
  it("keeps seer in the default set for regional sentry.io hosts", () => {
    const cfg = finalize({
      accessToken: "tok",
      host: "us.sentry.io",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("seer")).toBe(true);
  });

  it("excludes seer from the default set on self-hosted hosts", () => {
    const cfg = finalize({
      accessToken: "tok",
      host: "sentry.example.com",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("seer")).toBe(false);
    expect(cfg.finalSkills.has("inspect")).toBe(true);
    expect(cfg.finalSkills.has("triage")).toBe(true);
    expect(cfg.finalSkills.has("project-management")).toBe(true);
    expect(cfg.finalSkills.size).toBe(3);
  });

  it("excludes seer from the default set when self-hosted host comes from --url", () => {
    const cfg = finalize({
      accessToken: "tok",
      url: "https://sentry.example.com",
      unknownArgs: [],
    });
    expect(cfg.sentryHost).toBe("sentry.example.com");
    expect(cfg.finalSkills.has("seer")).toBe(false);
  });

  it("grants seer on self-hosted hosts when requested with --skills", () => {
    const cfg = finalize({
      accessToken: "tok",
      host: "sentry.example.com",
      skills: "inspect,seer",
      unknownArgs: [],
    });
    expect(cfg.finalSkills).toEqual(new Set(["inspect", "seer"]));
  });

  it("grants seer on self-hosted hosts with --all-skills", () => {
    const cfg = finalize({
      accessToken: "tok",
      host: "sentry.example.com",
      allSkills: true,
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("seer")).toBe(true);
    expect(cfg.finalSkills.size).toBe(4);
  });

  it("does not fail when --disable-skills=seer is used on a self-hosted host", () => {
    const cfg = finalize({
      accessToken: "tok",
      host: "sentry.example.com",
      disableSkills: "seer",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("seer")).toBe(false);
    expect(cfg.finalSkills.size).toBe(3);
  });

  it("rejects combining --all-skills with --skills", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        allSkills: true,
        skills: "inspect",
        unknownArgs: [],
      }),
    ).toThrow(/--all-skills cannot be combined with --skills/);
  });

  // --disable-skills tests
  it("removes disabled skills from default active-skills set", () => {
    const cfg = finalize({
      accessToken: "tok",
      disableSkills: "seer",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("seer")).toBe(false);
    expect(cfg.finalSkills.size).toBe(3);
    expect(cfg.finalSkills.has("inspect")).toBe(true);
    expect(cfg.finalSkills.has("triage")).toBe(true);
    expect(cfg.finalSkills.has("project-management")).toBe(true);
    expect(cfg.finalSkills.has("docs")).toBe(false);
    expect(cfg.finalSkills.has("preprod")).toBe(false);
  });

  it("removes disabled skills when combined with --skills", () => {
    const cfg = finalize({
      accessToken: "tok",
      skills: "inspect,triage,seer",
      disableSkills: "seer",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("seer")).toBe(false);
    expect(cfg.finalSkills.size).toBe(2);
    expect(cfg.finalSkills.has("inspect")).toBe(true);
    expect(cfg.finalSkills.has("triage")).toBe(true);
  });

  it("throws on invalid skill names in --disable-skills", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        disableSkills: "invalid-skill",
        unknownArgs: [],
      }),
    ).toThrow(/--disable-skills provided: invalid-skill/);
  });

  it("throws when all skills would be disabled", () => {
    expect(() =>
      finalize({
        accessToken: "tok",
        skills: "seer",
        disableSkills: "seer",
        unknownArgs: [],
      }),
    ).toThrow(/All skills have been disabled/);
  });

  it("supports multiple comma-separated disabled skills", () => {
    const cfg = finalize({
      accessToken: "tok",
      disableSkills: "seer,docs",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.has("seer")).toBe(false);
    expect(cfg.finalSkills.has("docs")).toBe(false);
    expect(cfg.finalSkills.size).toBe(3);
  });

  it("silently ignores disabling a skill not in the active set", () => {
    const cfg = finalize({
      accessToken: "tok",
      skills: "inspect,triage",
      disableSkills: "seer",
      unknownArgs: [],
    });
    expect(cfg.finalSkills.size).toBe(2);
    expect(cfg.finalSkills.has("inspect")).toBe(true);
    expect(cfg.finalSkills.has("triage")).toBe(true);
  });
});
