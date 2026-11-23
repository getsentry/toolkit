import { describe, expect, it } from "vitest";
import { ApiNotFoundError, ApiPermissionError } from "../../api-client";
import { withAlertWritePermissionHint } from "./alert-write-permission";

const DENIED = "You do not have permission to perform this action.";

describe("withAlertWritePermissionHint", () => {
  it("explains a bare 403 and keeps the API error", async () => {
    const error = new ApiPermissionError(DENIED);

    const thrown = await withAlertWritePermissionHint("Alert", () =>
      Promise.reject(error),
    ).catch((caught: unknown) => caught);

    expect(thrown).toBe(error);
    expect(error.status).toBe(403);
    expect(error.message).toBe(
      `${DENIED}\nChanging an Alert needs the alerts:write scope and permission to edit alerts in every project it connects to. An Alert that uses the all-projects source also needs org:write. Retrying with the same token will not help: reconnect Sentry with these scopes, or ask an organization Owner or Manager to make the change.`,
    );
  });

  it("names only alerts:write for Metric Monitors", async () => {
    const error = new ApiPermissionError(DENIED);

    await expect(
      withAlertWritePermissionHint("Metric Monitor", () =>
        Promise.reject(error),
      ),
    ).rejects.toBe(error);

    expect(error.message).toContain(
      "Changing a Metric Monitor needs the alerts:write scope",
    );
    expect(error.message).not.toContain("org:write");
  });

  it("leaves a 403 that names its missing scopes to the shared formatter", async () => {
    const error = new ApiPermissionError(DENIED, undefined, undefined, [
      "org:write",
    ]);

    await expect(
      withAlertWritePermissionHint("Alert", () => Promise.reject(error)),
    ).rejects.toBe(error);

    expect(error.message).toBe(DENIED);
  });

  it("leaves other API errors unchanged", async () => {
    const error = new ApiNotFoundError("Not found");

    await expect(
      withAlertWritePermissionHint("Alert", () => Promise.reject(error)),
    ).rejects.toBe(error);

    expect(error.message).toBe("Not found");
  });
});
