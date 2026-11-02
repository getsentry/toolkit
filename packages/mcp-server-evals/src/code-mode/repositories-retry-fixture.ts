import assert from "node:assert/strict";
import { createRepositoriesFixture } from "./repositories-fixture";

/** Inject one transient read failure; the task and inventory stay unchanged. */
export async function createRepositoriesRetryFixture({
  accessToken = "code-mode-eval-token",
}: {
  accessToken?: string;
} = {}) {
  const fixture = await createRepositoriesFixture({
    accessToken,
    injectedFailure: "initial-503",
  });
  return {
    ...fixture,
    provenance: {
      ...fixture.provenance,
      injectedFailure:
        "One initial repository collection GET returns synthetic HTTP 503 with Retry-After: 0; later reads use normal fixture pagination.",
    },
    verify(text: string) {
      assert.equal(
        fixture.snapshot().requests.filter((request) => request.status === 503)
          .length,
        1,
        "The agent must encounter the injected transient read failure",
      );
      return fixture.verify(text);
    },
  };
}
