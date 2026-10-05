import { afterEach, describe, expect, test } from "vitest";
import { getEnv, setEnv } from "../../src/lib/env.js";

describe("env registry", () => {
  afterEach(() => {
    // Always restore to process.env
    setEnv(process.env);
  });

  test("getEnv defaults to process.env", () => {
    expect(getEnv()).toBe(process.env);
  });

  test("setEnv switches the active env", () => {
    const custom = { CUSTOM_VAR: "test" } as NodeJS.ProcessEnv;
    setEnv(custom);
    expect(getEnv()).toBe(custom);
    expect(getEnv().CUSTOM_VAR).toBe("test");
  });

  test("setEnv(process.env) restores the default", () => {
    const custom = { CUSTOM_VAR: "test" } as NodeJS.ProcessEnv;
    setEnv(custom);
    setEnv(process.env);
    expect(getEnv()).toBe(process.env);
  });

  test("mutations to custom env don't affect process.env", () => {
    const key = `__ENV_TEST_${Date.now()}`;
    const custom: NodeJS.ProcessEnv = { ...process.env };
    setEnv(custom);
    getEnv()[key] = "mutated";

    expect(getEnv()[key]).toBe("mutated");
    expect(process.env[key]).toBeUndefined();
  });

  test("mutations to process.env are visible when active", () => {
    const key = `__ENV_TEST_${Date.now()}`;
    // Default: getEnv() IS process.env
    process.env[key] = "visible";
    expect(getEnv()[key]).toBe("visible");
    delete process.env[key];
  });
});
