import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { checkReadiness } from "../../../src/lib/init/readiness.js";
import type { WizardUI } from "../../../src/lib/init/ui/types.js";

function makeUI(): { ui: WizardUI; errors: string[]; warns: string[] } {
  const errors: string[] = [];
  const warns: string[] = [];
  const ui: WizardUI = {
    intro: () => {
      /* noop */
    },
    outro: () => {
      /* noop */
    },
    cancel: () => {
      /* noop */
    },
    feedback: () => {
      /* noop */
    },
    banner: () => {
      /* noop */
    },
    summary: () => {
      /* noop */
    },
    log: {
      info: () => {
        /* noop */
      },
      warn: (m) => warns.push(m),
      error: (m) => errors.push(m),
      success: () => {
        /* noop */
      },
      message: () => {
        /* noop */
      },
    },
    spinner: () => ({
      start: () => {
        /* noop */
      },
      message: () => {
        /* noop */
      },
      stop: () => {
        /* noop */
      },
    }),
    select: () => Promise.reject(new Error("noop")),
    multiselect: () => Promise.reject(new Error("noop")),
    confirm: () => Promise.reject(new Error("noop")),
    [Symbol.asyncDispose]: () => Promise.resolve(),
  };
  return { ui, errors, warns };
}

const OK_RESPONSE = new Response(null, { status: 200 });
const ERR_RESPONSE = new Response(null, { status: 503 });

let fetchSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  fetchSpy.mockRestore();
});

describe("checkReadiness", () => {
  test("resolves without error when the setup service is reachable", async () => {
    fetchSpy.mockResolvedValue(OK_RESPONSE.clone());
    const { ui, errors, warns } = makeUI();
    await expect(checkReadiness(ui)).resolves.toBeUndefined();
    expect(errors).toHaveLength(0);
    expect(warns).toHaveLength(0);
  });

  test("resolves but logs a warning when the setup service is unreachable", async () => {
    fetchSpy.mockRejectedValue(new Error("network failure"));
    const { ui, errors, warns } = makeUI();
    await expect(checkReadiness(ui)).resolves.toBeUndefined();
    expect(errors).toHaveLength(0);
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });

  test("resolves but logs a warning when the setup service returns non-ok status", async () => {
    fetchSpy.mockResolvedValue(ERR_RESPONSE.clone());
    const { ui, errors, warns } = makeUI();
    await expect(checkReadiness(ui)).resolves.toBeUndefined();
    expect(errors).toHaveLength(0);
    expect(warns.length).toBeGreaterThanOrEqual(1);
  });
});
