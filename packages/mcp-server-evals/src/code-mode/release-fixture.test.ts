import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createReleaseFixture } from "./release-fixture";
import { createReleaseRecoveryFixture } from "./release-recovery-fixture";

type Fixture = Awaited<ReturnType<typeof createReleaseFixture>>;
const active: Fixture[] = [];
const collection = "/api/0/organizations/release-evals/releases/";
const version = "checkout@2.4.0";
const releasePath = `${collection}${encodeURIComponent(version)}/`;
const released = "2026-10-26T10:00:00Z";
const completeAnswer = {
  version,
  projects: ["frontend", "backend"],
  dateReleased: released,
  deploymentId: "601",
};
const deployBody = {
  environment: "staging",
  name: "Staging rollout",
  url: "https://deploy.example.test/runs/42",
  dateStarted: "2026-10-26T10:02:00Z",
  dateFinished: "2026-10-26T10:04:00Z",
};

afterEach(async () => {
  await Promise.all(active.splice(0).map((fixture) => fixture.close()));
});

async function fixture(create = createReleaseFixture) {
  const instance = await create();
  active.push(instance);
  return instance;
}

function request(
  instance: Fixture,
  method: string,
  path: string,
  body?: unknown,
) {
  return fetch(`${instance.baseUrl}${path}`, {
    method,
    headers: {
      authorization: "Bearer code-mode-eval-token",
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("release Code Mode eval fixture", () => {
  it("persists the CLI create/finalize/deploy flow and exposes normal catalog read routes", async () => {
    const instance = await fixture();
    const created = await request(instance, "POST", collection, {
      version,
      projects: ["frontend", "backend"],
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ version, dateReleased: null });
    const finalized = await request(instance, "PUT", releasePath, {
      dateReleased: released,
    });
    expect(finalized.status).toBe(200);
    expect(await finalized.json()).toMatchObject({
      dateReleased: "2026-10-26T10:00:00.000Z",
    });
    const deployed = await request(
      instance,
      "POST",
      `${releasePath}deploys/`,
      deployBody,
    );
    expect(deployed.status).toBe(201);
    expect(await deployed.json()).toMatchObject({
      id: "601",
      environment: "staging",
    });
    expect(
      await (
        await request(instance, "GET", `${collection}?query=2.4.0`)
      ).json(),
    ).toMatchObject([{ version }]);
    expect(
      await (await request(instance, "GET", releasePath)).json(),
    ).toMatchObject({ version, deployCount: 1, lastDeploy: { id: "601" } });
    expect(
      await (await request(instance, "GET", `${releasePath}deploys/`)).json(),
    ).toMatchObject([{ id: "601" }]);
    expect(
      await (await request(instance, "GET", `${releasePath}commits/`)).json(),
    ).toEqual([]);
    expect(
      await (
        await request(
          instance,
          "GET",
          `/api/0/projects/release-evals/frontend/releases/${encodeURIComponent(version)}/`,
        )
      ).json(),
    ).toMatchObject({ version });
    expect(instance.verify(JSON.stringify(completeAnswer))).toEqual({
      success: true,
      releaseVersion: version,
      deployId: "601",
    });
    expect(() =>
      instance.verify(
        JSON.stringify({ ...completeAnswer, deploymentId: "999" }),
      ),
    ).toThrow("actual deployment ID");
    const { projects, dateReleased, ...incompleteAnswer } = completeAnswer;
    expect(() =>
      instance.verify(JSON.stringify({ ...incompleteAnswer, dateReleased })),
    ).toThrow();
    expect(() =>
      instance.verify(JSON.stringify({ ...incompleteAnswer, projects })),
    ).toThrow();
    expect(() =>
      instance.verify(
        JSON.stringify({ ...completeAnswer, projects: ["frontend"] }),
      ),
    ).toThrow("incorrect release projects");
    expect(() =>
      instance.verify(
        JSON.stringify({
          ...completeAnswer,
          dateReleased: "2026-10-25T10:00:00Z",
        }),
      ),
    ).toThrow("incorrect release time");
    expect(
      instance.verify(
        JSON.stringify({
          ...completeAnswer,
          dateReleased: "2026-10-26T12:00:00+02:00",
        }),
      ).success,
    ).toBe(true);
    instance.reset();
    expect(instance.snapshot().releases).toHaveLength(1);
    expect(instance.snapshot().requests).toEqual([]);
  });

  it("allows finalizing on create but rejects partial state and duplicate deployment success claims", async () => {
    const instance = await fixture();
    const body = {
      version,
      projects: ["frontend", "backend"],
      dateReleased: released,
    };
    expect((await request(instance, "POST", collection, body)).status).toBe(
      201,
    );
    expect((await request(instance, "POST", collection, body)).status).toBe(
      208,
    );
    expect(() => instance.verify(`${version} deployed as 601`)).toThrow(
      "exactly one new deployment",
    );
    expect(
      (await request(instance, "POST", `${releasePath}deploys/`, deployBody))
        .status,
    ).toBe(201);
    expect(instance.verify(JSON.stringify(completeAnswer)).success).toBe(true);
    expect(
      (await request(instance, "POST", `${releasePath}deploys/`, deployBody))
        .status,
    ).toBe(201);
    // The API lists the latest deployment per project/environment, while grading checks all persisted writes.
    expect(
      await (await request(instance, "GET", `${releasePath}deploys/`)).json(),
    ).toMatchObject([{ id: "602" }]);
    expect(() => instance.verify(`${version}: 602`)).toThrow(
      "exactly one new deployment",
    );
  });

  it("rejects invalid projects and detects changes to the existing release", async () => {
    const instance = await fixture();
    expect(
      (
        await request(instance, "POST", collection, {
          version,
          projects: ["unknown"],
        })
      ).status,
    ).toBe(400);
    expect(
      (await request(instance, "POST", `${releasePath}deploys/`, deployBody))
        .status,
    ).toBe(404);
    expect(
      (
        await request(instance, "POST", collection, {
          version,
          projects: ["frontend"],
          dateReleased: released,
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(instance, "POST", `${releasePath}deploys/`, {
          ...deployBody,
          projects: ["backend"],
        })
      ).status,
    ).toBe(400);
    expect(() => instance.verify(`${version}: 601`)).toThrow(
      "Release projects differ",
    );
    expect(
      (
        await request(instance, "PUT", `${collection}checkout%402.3.0/`, {
          dateReleased: released,
        })
      ).status,
    ).toBe(200);
    expect(() => instance.verify(`${version}: 601`)).toThrow(
      "Existing release changed",
    );
  });

  it("does not let an omitted finish time accidentally satisfy the requested timestamp", async () => {
    const instance = await fixture();
    await request(instance, "POST", collection, {
      version,
      projects: ["frontend", "backend"],
      dateReleased: released,
    });
    const { dateFinished, ...withoutFinished } = deployBody;
    const response = await request(
      instance,
      "POST",
      `${releasePath}deploys/`,
      withoutFinished,
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      dateFinished: "2026-10-26T12:00:00.000Z",
    });
    expect(() => instance.verify(`${version}: 601`)).toThrow(
      "Deployment configuration differs",
    );
  });

  it("recovers the actual persisted deployment after an ambiguous response without replaying the write", async () => {
    const instance = await fixture(createReleaseRecoveryFixture);
    const baseline = await fixture();
    expect(instance.prompt).toBe(baseline.prompt);
    expect(instance.provenance).toMatchObject({
      faultInjection: expect.stringContaining("simulated gateway 502"),
    });

    for (let run = 0; run < 2; run++) {
      await request(instance, "POST", collection, {
        version,
        projects: ["frontend", "backend"],
        dateReleased: released,
      });
      const response = await request(
        instance,
        "POST",
        `${releasePath}deploys/`,
        deployBody,
      );
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ detail: "Bad Gateway" });
      const savedRelease = z
        .object({
          version: z.string(),
          projects: z.array(z.object({ slug: z.string() })),
          dateReleased: z.string(),
          deployCount: z.number(),
        })
        .parse(await (await request(instance, "GET", releasePath)).json());
      const savedDeploys = z
        .array(z.object({ id: z.string() }))
        .parse(
          await (
            await request(instance, "GET", `${releasePath}deploys/`)
          ).json(),
        );
      expect(savedRelease).toMatchObject({ deployCount: 1 });
      expect(savedDeploys).toMatchObject([{ id: "601" }]);
      expect(
        instance.verify(
          JSON.stringify({
            version: savedRelease.version,
            projects: savedRelease.projects.map((project) => project.slug),
            dateReleased: savedRelease.dateReleased,
            deploymentId: savedDeploys[0].id,
          }),
        ).success,
      ).toBe(true);
      expect(instance.snapshot().requests.map(({ status }) => status)).toEqual([
        201, 502, 200, 200,
      ]);
      instance.reset();
    }
  });

  it("rejects a naive deployment replay even though the latest-deploy read hides the duplicate", async () => {
    const instance = await fixture(createReleaseRecoveryFixture);
    await request(instance, "POST", collection, {
      version,
      projects: ["frontend", "backend"],
      dateReleased: released,
    });
    expect(
      (await request(instance, "POST", `${releasePath}deploys/`, deployBody))
        .status,
    ).toBe(502);
    const retried = await request(
      instance,
      "POST",
      `${releasePath}deploys/`,
      deployBody,
    );
    expect(retried.status).toBe(201);
    expect(await retried.json()).toMatchObject({ id: "602" });
    expect(
      await (await request(instance, "GET", `${releasePath}deploys/`)).json(),
    ).toMatchObject([{ id: "602" }]);
    expect(instance.snapshot().deploys).toHaveLength(3);
    expect(() =>
      instance.verify(
        JSON.stringify({ ...completeAnswer, deploymentId: "602" }),
      ),
    ).toThrow("Expected exactly one new deployment");
  });
});
