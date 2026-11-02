import { createReleaseFixture } from "./release-fixture";

/** The same release task under a simulated ambiguous write outcome. */
export async function createReleaseRecoveryFixture({
  accessToken = "code-mode-eval-token",
}: {
  accessToken?: string;
} = {}) {
  const fixture = await createReleaseFixture({
    accessToken,
    simulateDeployResponseLoss: true,
  });
  return {
    ...fixture,
    provenance: {
      ...fixture.provenance,
      faultInjection:
        "One simulated gateway 502 after the first valid deployment POST persists. This is an infrastructure failure scenario, not a Sentry endpoint behavior. Replaying the POST creates another deployment.",
    },
  };
}
