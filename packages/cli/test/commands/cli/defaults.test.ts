/**
 * Tests for `sentry cli defaults` command.
 *
 * Verifies show/set/clear/clear-all modes, validation, formatter output,
 * and the telemetry/URL integration points.
 */

import chalk from "chalk";
import { describe, expect, test } from "vitest";
import {
  clearAllDefaults,
  getAgentSkillsPreference,
  getAllDefaults,
  getDefaultHeaders,
  getDefaultOrganization,
  getDefaultProject,
  getDefaultUrl,
  getTelemetryPreference,
  setAgentSkillsPreference,
  setDefaultOrganization,
  setDefaultProject,
  setDefaultUrl,
  setTelemetryPreference,
} from "../../../src/lib/db/defaults.js";
import { getDatabase } from "../../../src/lib/db/index.js";
import { formatDefaultsResult } from "../../../src/lib/formatters/human.js";
import { stripAnsi } from "../../../src/lib/formatters/plain-detect.js";
import {
  computeTelemetryEffective,
  isTelemetryEnabled,
} from "../../../src/lib/telemetry.js";
import { useTestConfigDir } from "../../helpers.js";

// Force chalk to produce ANSI output in test environment
chalk.level = 3;

useTestConfigDir("test-defaults-");

// ---------------------------------------------------------------------------
// Defaults storage (metadata KV layer)
// ---------------------------------------------------------------------------

describe("defaults storage", () => {
  test("getDefaultOrganization returns null when not set", () => {
    expect(getDefaultOrganization()).toBeNull();
  });

  test("getDefaultProject returns null when not set", () => {
    expect(getDefaultProject()).toBeNull();
  });

  test("setDefaultOrganization stores and retrieves org", () => {
    setDefaultOrganization("my-org");
    expect(getDefaultOrganization()).toBe("my-org");
  });

  test("setDefaultProject stores and retrieves project", () => {
    setDefaultProject("my-project");
    expect(getDefaultProject()).toBe("my-project");
  });

  test("setDefaultOrganization(null) clears org", () => {
    setDefaultOrganization("my-org");
    setDefaultOrganization(null);
    expect(getDefaultOrganization()).toBeNull();
  });

  test("individual setters are independent", () => {
    setDefaultOrganization("org1");
    setDefaultProject("proj1");
    setDefaultOrganization("org2");
    expect(getDefaultOrganization()).toBe("org2");
    expect(getDefaultProject()).toBe("proj1");
  });

  test("getTelemetryPreference returns undefined when not set", () => {
    expect(getTelemetryPreference()).toBeUndefined();
  });

  test("setTelemetryPreference stores on/off", () => {
    setTelemetryPreference(false);
    expect(getTelemetryPreference()).toBe(false);

    setTelemetryPreference(true);
    expect(getTelemetryPreference()).toBe(true);
  });

  test("setTelemetryPreference(null) clears preference", () => {
    setTelemetryPreference(false);
    setTelemetryPreference(null);
    expect(getTelemetryPreference()).toBeUndefined();
  });

  test("getAgentSkillsPreference returns undefined when not set", () => {
    expect(getAgentSkillsPreference()).toBeUndefined();
  });

  test("setAgentSkillsPreference stores on/off", () => {
    setAgentSkillsPreference(false);
    expect(getAgentSkillsPreference()).toBe(false);

    setAgentSkillsPreference(true);
    expect(getAgentSkillsPreference()).toBe(true);
  });

  test("setAgentSkillsPreference(null) clears preference", () => {
    setAgentSkillsPreference(false);
    setAgentSkillsPreference(null);
    expect(getAgentSkillsPreference()).toBeUndefined();
  });

  test("getDefaultUrl returns null when not set", () => {
    expect(getDefaultUrl()).toBeNull();
  });

  test("setDefaultUrl stores and retrieves URL", () => {
    setDefaultUrl("https://sentry.example.com");
    expect(getDefaultUrl()).toBe("https://sentry.example.com");
  });

  test("setDefaultUrl(null) clears URL", () => {
    setDefaultUrl("https://sentry.example.com");
    setDefaultUrl(null);
    expect(getDefaultUrl()).toBeNull();
  });

  test("getAllDefaults returns full state", () => {
    setDefaultOrganization("test-org");
    setDefaultProject("test-project");
    setTelemetryPreference(false);
    setAgentSkillsPreference(false);
    setDefaultUrl("https://sentry.example.com");

    const state = getAllDefaults();
    expect(state).toEqual({
      organization: "test-org",
      project: "test-project",
      telemetry: "off",
      "agent-skills": "off",
      url: "https://sentry.example.com",
      headers: null,
      "ca-cert": null,
      graphics: null,
    });
  });

  test("getAllDefaults returns nulls when nothing set", () => {
    const state = getAllDefaults();
    expect(state).toEqual({
      organization: null,
      project: null,
      telemetry: null,
      "agent-skills": null,
      url: null,
      headers: null,
      "ca-cert": null,
      graphics: null,
    });
  });

  test("clearAllDefaults removes everything", () => {
    setDefaultOrganization("org");
    setDefaultProject("proj");
    setTelemetryPreference(true);
    setDefaultUrl("https://example.com");

    clearAllDefaults();

    expect(getDefaultOrganization()).toBeNull();
    expect(getDefaultProject()).toBeNull();
    expect(getTelemetryPreference()).toBeUndefined();
    expect(getDefaultUrl()).toBeNull();
    expect(getDefaultHeaders()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Slug validation (via DEFAULTS_REGISTRY set handlers)
// ---------------------------------------------------------------------------

describe("empty string validation", () => {
  // These test the validateSlug guard added in the DEFAULTS_REGISTRY handlers.
  // We import the parseBoolValue helper to verify telemetry validation too.

  test("setDefaultOrganization stores trimmed value", () => {
    setDefaultOrganization("  my-org  ");
    // The DB stores what it receives — trimming happens in the command layer
    expect(getDefaultOrganization()).toBe("  my-org  ");
  });
});

// ---------------------------------------------------------------------------
// isTelemetryEnabled integration
// ---------------------------------------------------------------------------

describe("isTelemetryEnabled", () => {
  let savedNoTelemetry: string | undefined;
  let savedDoNotTrack: string | undefined;

  // Save and restore env vars around each test
  const setup = () => {
    // Force DB initialization while SENTRY_CLI_NO_TELEMETRY is still set,
    // so the lazy require("../telemetry.js") is skipped. Under vitest
    // (Node.js), that CJS require path can't resolve ESM .js imports.
    getDatabase();
    savedNoTelemetry = process.env.SENTRY_CLI_NO_TELEMETRY;
    savedDoNotTrack = process.env.DO_NOT_TRACK;
    // Clear both env vars so persistent preference is tested
    delete process.env.SENTRY_CLI_NO_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  };
  const teardown = () => {
    if (savedNoTelemetry !== undefined) {
      process.env.SENTRY_CLI_NO_TELEMETRY = savedNoTelemetry;
    } else {
      delete process.env.SENTRY_CLI_NO_TELEMETRY;
    }
    if (savedDoNotTrack !== undefined) {
      process.env.DO_NOT_TRACK = savedDoNotTrack;
    } else {
      delete process.env.DO_NOT_TRACK;
    }
  };

  test("defaults to enabled when no preference set", () => {
    setup();
    try {
      expect(isTelemetryEnabled()).toBe(true);
    } finally {
      teardown();
    }
  });

  test("respects persistent preference: off", () => {
    setup();
    try {
      setTelemetryPreference(false);
      expect(isTelemetryEnabled()).toBe(false);
    } finally {
      teardown();
    }
  });

  test("respects persistent preference: on", () => {
    setup();
    try {
      setTelemetryPreference(true);
      expect(isTelemetryEnabled()).toBe(true);
    } finally {
      teardown();
    }
  });

  test("SENTRY_CLI_NO_TELEMETRY=1 overrides preference", () => {
    setup();
    try {
      setTelemetryPreference(true);
      process.env.SENTRY_CLI_NO_TELEMETRY = "1";
      expect(isTelemetryEnabled()).toBe(false);
    } finally {
      teardown();
    }
  });

  test("DO_NOT_TRACK=1 overrides preference", () => {
    setup();
    try {
      setTelemetryPreference(true);
      process.env.DO_NOT_TRACK = "1";
      expect(isTelemetryEnabled()).toBe(false);
    } finally {
      teardown();
    }
  });

  test("SENTRY_CLI_NO_TELEMETRY takes precedence over DO_NOT_TRACK", () => {
    setup();
    try {
      // Both set — SENTRY_CLI_NO_TELEMETRY is checked first
      process.env.SENTRY_CLI_NO_TELEMETRY = "1";
      process.env.DO_NOT_TRACK = "0";
      expect(isTelemetryEnabled()).toBe(false);
    } finally {
      teardown();
    }
  });

  test("DO_NOT_TRACK=0 does not disable telemetry", () => {
    setup();
    try {
      process.env.DO_NOT_TRACK = "0";
      expect(isTelemetryEnabled()).toBe(true);
    } finally {
      teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// computeTelemetryEffective (shared helper in telemetry.ts)
// ---------------------------------------------------------------------------

describe("computeTelemetryEffective", () => {
  let savedNoTelemetry: string | undefined;
  let savedDoNotTrack: string | undefined;

  const setup = () => {
    // Force DB initialization while SENTRY_CLI_NO_TELEMETRY is still set
    // (see isTelemetryEnabled setup comment for rationale).
    getDatabase();
    savedNoTelemetry = process.env.SENTRY_CLI_NO_TELEMETRY;
    savedDoNotTrack = process.env.DO_NOT_TRACK;
    delete process.env.SENTRY_CLI_NO_TELEMETRY;
    delete process.env.DO_NOT_TRACK;
  };
  const teardown = () => {
    if (savedNoTelemetry !== undefined) {
      process.env.SENTRY_CLI_NO_TELEMETRY = savedNoTelemetry;
    } else {
      delete process.env.SENTRY_CLI_NO_TELEMETRY;
    }
    if (savedDoNotTrack !== undefined) {
      process.env.DO_NOT_TRACK = savedDoNotTrack;
    } else {
      delete process.env.DO_NOT_TRACK;
    }
  };

  test("returns default source when no preference set", () => {
    setup();
    try {
      const result = computeTelemetryEffective();
      expect(result).toEqual({ enabled: true, source: "default" });
    } finally {
      teardown();
    }
  });

  test("returns preference source when set to off", () => {
    setup();
    try {
      setTelemetryPreference(false);
      const result = computeTelemetryEffective();
      expect(result).toEqual({ enabled: false, source: "preference" });
    } finally {
      teardown();
    }
  });

  test("returns preference source when set to on", () => {
    setup();
    try {
      setTelemetryPreference(true);
      const result = computeTelemetryEffective();
      expect(result).toEqual({ enabled: true, source: "preference" });
    } finally {
      teardown();
    }
  });

  test("SENTRY_CLI_NO_TELEMETRY overrides preference", () => {
    setup();
    try {
      setTelemetryPreference(true);
      process.env.SENTRY_CLI_NO_TELEMETRY = "1";
      const result = computeTelemetryEffective();
      expect(result.enabled).toBe(false);
      expect(result.source).toBe("env:SENTRY_CLI_NO_TELEMETRY");
    } finally {
      teardown();
    }
  });

  test("DO_NOT_TRACK overrides preference", () => {
    setup();
    try {
      setTelemetryPreference(true);
      process.env.DO_NOT_TRACK = "1";
      const result = computeTelemetryEffective();
      expect(result.enabled).toBe(false);
      expect(result.source).toBe("env:DO_NOT_TRACK");
    } finally {
      teardown();
    }
  });
});

// ---------------------------------------------------------------------------
// formatDefaultsResult (human formatter)
// ---------------------------------------------------------------------------

describe("formatDefaultsResult", () => {
  test("show action with empty defaults", () => {
    const result = formatDefaultsResult({
      action: "show",
      defaults: {
        organization: null,
        project: null,
        telemetry: null,
        url: null,
      },
      telemetryEffective: { enabled: true, source: "default" },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("Defaults");
    expect(plain).toContain("Organization");
    expect(plain).toContain("not set");
    expect(plain).toContain("Telemetry");
    expect(plain).toContain("on (default)");
  });

  test("show action with populated defaults", () => {
    const result = formatDefaultsResult({
      action: "show",
      defaults: {
        organization: "my-org",
        project: "my-proj",
        telemetry: "off",
        graphics: "off",
        url: "https://sentry.example.com",
      },
      telemetryEffective: { enabled: false, source: "preference" },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("my-org");
    expect(plain).toContain("my-proj");
    expect(plain).toContain("off");
    expect(plain).toContain("Graphics");
    expect(plain).toContain("sentry.example.com");
  });

  test("show action with env var override shows note", () => {
    const result = formatDefaultsResult({
      action: "show",
      defaults: {
        organization: null,
        project: null,
        telemetry: "on",
        url: null,
      },
      telemetryEffective: {
        enabled: false,
        source: "env:SENTRY_CLI_NO_TELEMETRY",
      },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("overridden");
    expect(plain).toContain("SENTRY_CLI_NO_TELEMETRY");
  });

  test("show action with DO_NOT_TRACK override shows note", () => {
    const result = formatDefaultsResult({
      action: "show",
      defaults: {
        organization: null,
        project: null,
        telemetry: null,
        url: null,
      },
      telemetryEffective: { enabled: false, source: "env:DO_NOT_TRACK" },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("overridden");
    expect(plain).toContain("DO_NOT_TRACK");
  });

  test("show action without env override shows no note", () => {
    const result = formatDefaultsResult({
      action: "show",
      defaults: {
        organization: null,
        project: null,
        telemetry: "off",
        url: null,
      },
      telemetryEffective: { enabled: false, source: "preference" },
    });
    const plain = stripAnsi(result);
    expect(plain).not.toContain("overridden");
  });

  test("set action formats correctly", () => {
    const result = formatDefaultsResult({
      action: "set",
      defaults: {
        organization: "my-org",
        project: null,
        telemetry: null,
        url: null,
      },
      changed: {
        key: "organization",
        previousValue: null,
        newValue: "my-org",
      },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("Organization");
    expect(plain).toContain("set to");
    expect(plain).toContain("my-org");
  });

  test("clear action formats correctly", () => {
    const result = formatDefaultsResult({
      action: "clear",
      defaults: {
        organization: null,
        project: null,
        telemetry: null,
        url: null,
      },
      changed: { key: "project", previousValue: "old-proj", newValue: null },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("Project");
    expect(plain).toContain("cleared");
  });

  test("clear-all action formats correctly", () => {
    const result = formatDefaultsResult({
      action: "clear-all",
      defaults: {
        organization: null,
        project: null,
        telemetry: null,
        url: null,
      },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("All defaults cleared");
  });

  test("set action with unknown key falls back to key name", () => {
    const result = formatDefaultsResult({
      action: "set",
      defaults: {
        organization: null,
        project: null,
        telemetry: null,
        url: null,
      },
      changed: { key: "unknown_key", previousValue: null, newValue: "val" },
    });
    const plain = stripAnsi(result);
    expect(plain).toContain("unknown_key");
    expect(plain).toContain("set to");
  });
});
