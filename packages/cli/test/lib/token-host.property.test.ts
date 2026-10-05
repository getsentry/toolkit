/**
 * Property-based tests for host-scoping trust model.
 *
 * Verifies invariants that must hold for ANY input:
 * - Trust is symmetric within the SaaS equivalence class.
 * - Non-SaaS hosts only match exact origin (no subdomain suffix tricks).
 * - Normalization is idempotent.
 * - Requests with unparseable URLs are never trusted.
 *
 * Unit tests for specific edge cases live in test/lib/token-host.test.ts.
 */

import {
  constantFrom,
  assert as fcAssert,
  property,
  stringMatching,
  tuple,
} from "fast-check";
import { describe, expect, test } from "vitest";
import { normalizeOrigin } from "../../src/lib/sentry-urls.js";
import { isHostTrusted } from "../../src/lib/token-host.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

// Arbitraries

/** Host chars: lowercase alphanumerics + hyphen */
const HOST_LABEL = stringMatching(/^[a-z0-9][a-z0-9-]{0,20}$/);

/** Two-label lowercase host (e.g. "example.com") */
const simpleHostArb = tuple(HOST_LABEL, HOST_LABEL).map(
  ([a, b]) => `${a}.${b}`
);

/** Non-SaaS host: never ends with `sentry.io` */
const nonSaasHostArb = simpleHostArb.filter(
  (h) => h !== "sentry.io" && !h.endsWith(".sentry.io")
);

/** SaaS host: any subdomain of sentry.io (including bare `sentry.io`) */
const saasSubdomainArb = HOST_LABEL.filter((label) => {
  try {
    new URL(`https://${label}.sentry.io/`);
    return true;
  } catch {
    // Some generated labels (e.g. `xn--`) produce invalid WHATWG URLs.
    return false;
  }
}).map((label) => `${label}.sentry.io`);

/** Protocol */
const protoArb = constantFrom("http", "https");

describe("property: normalizeOrigin is idempotent", () => {
  test("normalize(normalize(x)) === normalize(x)", () => {
    fcAssert(
      property(protoArb, simpleHostArb, (proto, host) => {
        const url = `${proto}://${host}/some/path?q=1`;
        const once = normalizeOrigin(url);
        if (once === undefined) {
          return;
        }
        expect(normalizeOrigin(once)).toBe(once);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: SaaS equivalence is reflexive + symmetric", () => {
  test("any sentry.io subdomain matches any other sentry.io subdomain", () => {
    fcAssert(
      property(saasSubdomainArb, saasSubdomainArb, (a, b) => {
        // Both a and b are https://<label>.sentry.io
        expect(isHostTrusted(`https://${a}/any/path`, `https://${b}`)).toBe(
          true
        );
        // And the converse
        expect(isHostTrusted(`https://${b}/any/path`, `https://${a}`)).toBe(
          true
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("bare sentry.io matches any sentry.io subdomain", () => {
    fcAssert(
      property(saasSubdomainArb, (subdomain) => {
        expect(
          isHostTrusted(`https://${subdomain}/`, "https://sentry.io")
        ).toBe(true);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: SaaS trust-class rejects http:// and non-default ports", () => {
  test("http:// sentry.io subdomain is NEVER trusted as SaaS", () => {
    fcAssert(
      property(saasSubdomainArb, (subdomain) => {
        expect(isHostTrusted(`http://${subdomain}/`, "https://sentry.io")).toBe(
          false
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-default port on sentry.io is NEVER trusted as SaaS", () => {
    fcAssert(
      property(saasSubdomainArb, (subdomain) => {
        // Port 8443 is never default for https (443) or http (80).
        expect(
          isHostTrusted(`https://${subdomain}:8443/`, "https://sentry.io")
        ).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: non-SaaS hosts require exact origin match", () => {
  test("non-SaaS host never trusts a different non-SaaS host", () => {
    fcAssert(
      property(nonSaasHostArb, nonSaasHostArb, (a, b) => {
        if (a === b) {
          return; // Skip identical hosts — that's trivially trusted
        }
        expect(isHostTrusted(`https://${a}/`, `https://${b}`)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("non-SaaS host never trusts any SaaS host", () => {
    fcAssert(
      property(nonSaasHostArb, saasSubdomainArb, (nonSaas, saas) => {
        // Non-SaaS token → SaaS request: not trusted
        expect(isHostTrusted(`https://${saas}/`, `https://${nonSaas}`)).toBe(
          false
        );
        // SaaS token → non-SaaS request: not trusted
        expect(isHostTrusted(`https://${nonSaas}/`, `https://${saas}`)).toBe(
          false
        );
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: no subdomain-attack against non-SaaS hosts", () => {
  test("sentry.acme.com token never trusts <anything>.sentry.acme.com or sentry.acme.<anything>", () => {
    fcAssert(
      property(HOST_LABEL, HOST_LABEL, (attackerLabel, evilTld) => {
        // Attacker tries to append a subdomain: <attackerLabel>.sentry.acme.com
        const trusted = "https://sentry.acme.com";
        const suffixAttack = `https://${attackerLabel}.sentry.acme.com/`;
        if (`${attackerLabel}.sentry.acme.com` !== "sentry.acme.com") {
          expect(isHostTrusted(suffixAttack, trusted)).toBe(false);
        }
        // Attacker tries to swap the TLD: sentry.acme.<evilTld>
        if (evilTld !== "com") {
          const tldAttack = `https://sentry.acme.${evilTld}/`;
          expect(isHostTrusted(tldAttack, trusted)).toBe(false);
        }
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });

  test("look-alike SaaS hosts are NOT trusted as SaaS", () => {
    fcAssert(
      property(HOST_LABEL, HOST_LABEL, (prefix, evilTld) => {
        // e.g. "sentry.io.evil.com" — not actually a sentry.io subdomain
        if (evilTld === "io" || evilTld === "sentry") {
          return;
        }
        const lookalike = `https://sentry.io.${prefix}.${evilTld}/`;
        expect(isHostTrusted(lookalike, "https://sentry.io")).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});

describe("property: unparseable candidates are never trusted", () => {
  test("non-URL strings fail the trust check regardless of trusted host", () => {
    fcAssert(
      property(simpleHostArb, (trustedHost) => {
        const trusted = `https://${trustedHost}`;
        expect(isHostTrusted("not a url", trusted)).toBe(false);
        expect(isHostTrusted("", trusted)).toBe(false);
        expect(isHostTrusted("javascript:alert(1)", trusted)).toBe(false);
      }),
      { numRuns: DEFAULT_NUM_RUNS }
    );
  });
});
