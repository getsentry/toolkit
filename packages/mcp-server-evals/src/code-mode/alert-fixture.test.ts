import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createAlertFixture } from "./alert-fixture";

type Fixture = Awaited<ReturnType<typeof createAlertFixture>>;
const active: Fixture[] = [];
const accessToken = "local-alert-test-token";
const finalAnswer = JSON.stringify({
  id: "701",
  enabled: false,
  frequency: 60,
});

afterEach(async () => {
  await Promise.all(active.splice(0).map((fixture) => fixture.close()));
});

async function fixture() {
  const instance = await createAlertFixture({ accessToken });
  active.push(instance);
  return instance;
}

function request(instance: Fixture, id = "701", body?: unknown) {
  return fetch(
    `${instance.baseUrl}/api/0/organizations/${instance.organizationSlug}/workflows/${id}/`,
    {
      method: body === undefined ? "GET" : "PUT",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
  );
}

async function editBody(instance: Fixture) {
  const response = await request(instance);
  expect(response.status).toBe(200);
  const source = z.record(z.string(), z.unknown()).parse(await response.json());
  return { ...source, enabled: false, config: { frequency: 60 } };
}

describe("issue alert Code Mode eval fixture", () => {
  it("serves project scope and detector reads used by the ordinary alert tool", async () => {
    const instance = await fixture();
    const paths = [
      "/api/0/projects/alert-evals/frontend/",
      "/api/0/organizations/alert-evals/workflows/701/project-scope/",
      "/api/0/organizations/alert-evals/detectors/901/",
      "/api/0/organizations/alert-evals/workflows/",
      "/api/0/organizations/alert-evals/detectors/",
    ];
    const responses = await Promise.all(
      paths.map((path) =>
        fetch(`${instance.baseUrl}${path}`, {
          headers: { authorization: `Bearer ${accessToken}` },
        }),
      ),
    );
    expect(responses.map(({ status }) => status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    const [project, scope, detector, workflows, detectors] = await Promise.all(
      responses.map((response) => response.json()),
    );
    expect(project).toEqual({
      id: "101",
      slug: "frontend",
      name: "Frontend",
      platform: "javascript",
    });
    expect(scope).toEqual({ projectIds: ["101"], includesAllProjects: false });
    expect(detector).toMatchObject({
      id: "901",
      projectId: "101",
      type: "error",
      enabled: true,
      workflowIds: ["701", "702"],
      config: {},
      conditionGroup: null,
      dataSources: [],
      dateCreated: "2026-10-25T10:00:00.000Z",
      dateUpdated: "2026-10-25T10:00:00.000Z",
    });
    expect(workflows).toEqual(instance.snapshot().workflows);
    expect(detectors).toEqual([detector]);
    expect(
      instance.snapshot().workflows.every((workflow) => workflow.enabled),
    ).toBe(true);
  });

  it("persists the CLI-equivalent edit and preserves nested alert configuration", async () => {
    const instance = await fixture();
    const before = instance.snapshot();
    const body = await editBody(instance);
    const updated = await request(instance, "701", body);
    expect(updated.status).toBe(200);
    const fetched = await request(instance);
    expect(await fetched.json()).toMatchObject({
      id: "701",
      enabled: false,
      config: { frequency: 60 },
      environment: "production",
      owner: "team:42",
      detectorIds: ["901"],
      triggers: before.workflows[0].triggers,
      actionFilters: before.workflows[0].actionFilters,
    });
    expect(instance.verify(finalAnswer)).toEqual({
      success: true,
      workflowId: "701",
      enabled: false,
      frequency: 60,
    });
    expect(instance.snapshot().workflows[1]).toEqual(before.workflows[1]);
    expect(instance.snapshot().writes).toEqual([
      { workflowId: "701", workflows: instance.snapshot().workflows },
    ]);
    expect(instance.snapshot().requests.map(({ method }) => method)).toEqual([
      "GET",
      "PUT",
      "GET",
    ]);
    instance.reset();
    expect(instance.snapshot()).toEqual(before);
  });

  it("preserves omitted optional fields and requires name as WorkflowValidator does", async () => {
    const instance = await fixture();
    const missingName = await request(instance, "701", {
      enabled: false,
      config: { frequency: 60 },
    });
    expect(missingName.status).toBe(400);
    expect(instance.snapshot().workflows[0].enabled).toBe(true);
    const response = await request(instance, "701", {
      name: "Frontend production errors",
      enabled: false,
      config: { frequency: 60 },
    });
    expect(response.status).toBe(200);
    expect(instance.verify(finalAnswer).success).toBe(true);
  });

  it("accepts snake_case nested fields but rejects alias collisions", async () => {
    const instance = await fixture();
    const body = await editBody(instance);
    const snakeBody = JSON.parse(
      JSON.stringify(body).replace(
        /"([A-Za-z]+)":/g,
        (_, key: string) =>
          `"${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}":`,
      ),
    ) as unknown;
    expect((await request(instance, "701", snakeBody)).status).toBe(200);
    expect(instance.verify(finalAnswer).success).toBe(true);
    const collision = await request(instance, "701", {
      ...body,
      detector_ids: [902],
    });
    expect(collision.status).toBe(400);
    expect(instance.verify(finalAnswer).success).toBe(true);
  });

  it("rejects a claimed success when the edit dropped notification actions", async () => {
    const instance = await fixture();
    const body = await editBody(instance);
    expect(
      (await request(instance, "701", { ...body, actionFilters: [] })).status,
    ).toBe(200);
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Alert settings other than enabled/frequency changed",
    );
  });

  it("rejects success after an unrelated alert was changed", async () => {
    const instance = await fixture();
    expect(
      (await request(instance, "701", await editBody(instance))).status,
    ).toBe(200);
    expect(
      (
        await request(instance, "702", {
          name: "Backend production errors",
          enabled: false,
        })
      ).status,
    ).toBe(200);
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Unrelated alert changed",
    );
  });

  it("rejects temporarily clearing monitor connections even after restoring them", async () => {
    const instance = await fixture();
    const body = await editBody(instance);
    expect(
      (await request(instance, "701", { ...body, detectorIds: [] })).status,
    ).toBe(200);
    expect((await request(instance, "701", body)).status).toBe(200);
    const state = instance.snapshot();
    expect(state.workflows[0].detectorIds).toEqual(["901"]);
    expect(state.writes.map((write) => write.workflows[0].detectorIds)).toEqual(
      [[], ["901"]],
    );
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Write 1: unrelated alert settings changed during the operation",
    );
  });

  it("rejects wrong reported values even when the expected tokens appear elsewhere", async () => {
    const instance = await fixture();
    expect(
      (await request(instance, "701", await editBody(instance))).status,
    ).toBe(200);
    const wrongAnswer = JSON.stringify({
      id: "999",
      enabled: true,
      frequency: 15,
      note: "The requested values were alert 701, false (disabled), 60 minutes.",
    });
    expect(() => instance.verify(wrongAnswer)).toThrow(
      "Final answer does not match the saved alert values",
    );
  });

  it("rejects an invented success and an answer that omits the actual result", async () => {
    const instance = await fixture();
    expect(() => instance.verify(finalAnswer)).toThrow(
      "Target alert is still enabled",
    );
    expect(
      (await request(instance, "701", await editBody(instance))).status,
    ).toBe(200);
    expect(() => instance.verify("Done.")).toThrow(
      "Final answer must include the saved values as JSON",
    );
  });
});
