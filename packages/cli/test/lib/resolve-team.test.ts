/**
 * Tests for resolveOrCreateTeam error handling. Mocks the teams API so
 * listTeams failures can be exercised without real HTTP calls.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("../../src/lib/api/teams.js");
vi.mock("../../src/lib/api/organizations.js");

// biome-ignore lint/performance/noNamespaceImport: needed for vi.spyOn mocking
import * as teamsApi from "../../src/lib/api/teams.js";
import { ApiError, ResolutionError } from "../../src/lib/errors.js";
import { resolveOrCreateTeam } from "../../src/lib/resolve-team.js";

describe("resolveOrCreateTeam", () => {
  const listTeamsSpy = vi.mocked(teamsApi.listTeams);

  afterEach(() => {
    listTeamsSpy.mockReset();
  });

  test("re-throws the original ApiError when listTeams returns 401", async () => {
    // member-disabled-over-limit and other 401s must keep their enriched detail
    // instead of being flattened into a generic ResolutionError.
    const apiError = new ApiError(
      "Failed to list teams",
      401,
      "Your account is disabled in this organization because it is over its member limit."
    );
    listTeamsSpy.mockRejectedValueOnce(apiError);

    const error = await resolveOrCreateTeam("chisme", {
      usageHint: "sentry init",
    }).catch((e) => e);

    expect(error).toBe(apiError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).not.toBeInstanceOf(ResolutionError);
    expect(error.status).toBe(401);
    expect(error.detail).toContain("over its member limit");
  });
});
