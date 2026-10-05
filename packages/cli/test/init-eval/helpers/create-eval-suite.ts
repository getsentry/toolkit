import { afterAll, describe, expect, test } from "vitest";
import { runAssertions } from "./assertions";
import { fetchDocsContent } from "./docs-fetcher";
import { judgeFeature } from "./judge";
import { getPlatform, WIZARD_FEATURE_IDS } from "./platforms";
import { runWizard, type WizardResult } from "./run-wizard";
import { createTestEnv } from "./test-env";

/**
 * Creates a standard eval test suite for a given platform.
 *
 * Runs the wizard once with all features, then:
 * 1. Code-based hard assertions (deterministic)
 * 2. Per-feature LLM judge calls (one test per feature)
 */
export function createEvalSuite(platformId: string) {
  const p = getPlatform(platformId);
  const env = createTestEnv(p.templateDir);
  let result: WizardResult;

  // Only pass features that are valid wizard --features flag values
  const wizardFeatures = p.docs
    .map((d) => d.feature)
    .filter((f) => WIZARD_FEATURE_IDS.has(f));

  afterAll(() => env.cleanup());

  describe(`eval: ${p.name}`, () => {
    test(
      "wizard completes",
      async () => {
        result = await runWizard(env.projectDir, p, wizardFeatures);
        expect(result.exitCode).toBe(0);
      },
      p.timeout
    );

    test("hard assertions pass", async () => {
      const failures = runAssertions(env.projectDir, p, result);
      if (failures.length > 0) {
        console.log("Assertion failures:", JSON.stringify(failures, null, 2));
      }
      expect(failures).toEqual([]);
    }, 120_000);

    // Per-feature LLM judge — one test per feature
    for (const doc of p.docs) {
      test(`judge: ${doc.feature}`, async () => {
        const docsContent = await fetchDocsContent(doc.docsUrls);
        const verdict = await judgeFeature(result, p, doc, docsContent);
        if (verdict) {
          expect(verdict.score).toBeGreaterThanOrEqual(0.5);
        }
      }, 60_000);
    }
  });
}
