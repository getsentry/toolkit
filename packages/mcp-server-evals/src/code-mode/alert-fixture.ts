import assert from "node:assert/strict";
import { z } from "zod";
import { startApiFixture } from "./api-fixture";
import { parseEvalJsonAnswer } from "./json-answer";

const ORGANIZATION = "alert-evals";
const WORKFLOW_ID = "701";
const OTHER_WORKFLOW_ID = "702";
const DATE_CREATED = "2026-10-25T10:00:00.000Z";
const DATE_UPDATED = "2026-10-26T10:00:00.000Z";

const answerSchema = z.object({
  id: z.union([z.string(), z.number().int().positive()]).transform(String),
  enabled: z.boolean(),
  frequency: z.number().int(),
});
const conditionSchema = z.object({
  id: z.coerce.string().optional(),
  type: z.string(),
  comparison: z.unknown(),
  conditionResult: z.unknown(),
});
const actionSchema = z.object({
  id: z.coerce.string().optional(),
  type: z.string(),
  integrationId: z.coerce.string().nullable().optional(),
  data: z.record(z.string(), z.unknown()),
  config: z.record(z.string(), z.unknown()),
  status: z.string().default("active"),
});
const groupSchema = z.object({
  id: z.coerce.string().optional(),
  logicType: z.enum(["all", "any", "any-short"]),
  conditions: z.array(conditionSchema).default([]),
});
const actionFilterSchema = groupSchema.extend({
  actions: z.array(actionSchema),
});
const updateSchema = z.object({
  name: z.string().min(1).max(256),
  enabled: z.boolean().default(true),
  config: z
    .object({ frequency: z.number().int().min(0).optional() })
    .strict()
    .optional(),
  environment: z.string().nullable().optional(),
  owner: z.string().nullable().optional(),
  detectorIds: z.array(z.coerce.string()).optional(),
  triggers: groupSchema.optional(),
  actionFilters: z.array(actionFilterSchema).optional(),
});

type Group = z.infer<typeof groupSchema> & {
  id: string;
  organizationId: string;
  actions: z.infer<typeof actionSchema>[];
};
interface Workflow {
  id: string;
  name: string;
  organizationId: string;
  createdBy: string;
  dateCreated: string;
  dateUpdated: string;
  triggers: Group;
  actionFilters: Group[];
  environment: string | null;
  config: { frequency?: number };
  detectorIds: string[];
  enabled: boolean;
  lastTriggered: string | null;
  owner: string | null;
}

// CamelSnakeSerializer accepts either spelling recursively. Detect collisions
// before normalizing so the fixture cannot silently accept contradictory fields.
function camelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(camelKeys);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const converted = key.replace(/_([a-z])/g, (_, letter: string) =>
      letter.toUpperCase(),
    );
    if (Object.hasOwn(result, converted)) {
      throw new SyntaxError(`${key} collides with ${converted}`);
    }
    result[converted] = camelKeys(item);
  }
  return result;
}

// Sanitized shape from WorkflowEngineExamples.GET_WORKFLOW and its serializers.
function sourceWorkflow(id: string, name: string): Workflow {
  return {
    id,
    name,
    organizationId: "1",
    createdBy: "10",
    dateCreated: DATE_CREATED,
    dateUpdated: DATE_CREATED,
    triggers: {
      id: `${id}1`,
      organizationId: "1",
      logicType: "any-short",
      conditions: [
        {
          id: `${id}11`,
          type: "first_seen_event",
          comparison: true,
          conditionResult: true,
        },
        {
          id: `${id}12`,
          type: "regression_event",
          comparison: true,
          conditionResult: true,
        },
      ],
      actions: [],
    },
    actionFilters: [
      {
        id: `${id}2`,
        organizationId: "1",
        logicType: "all",
        conditions: [
          {
            id: `${id}21`,
            type: "issue_priority_deescalating",
            comparison: true,
            conditionResult: true,
          },
        ],
        actions: [
          {
            id: `${id}31`,
            type: "slack",
            integrationId: "20",
            data: {},
            config: {
              targetType: "specific",
              targetDisplay: "#frontend-alerts",
              targetIdentifier: "C0000000001",
            },
            status: "active",
          },
          {
            id: `${id}32`,
            type: "slack",
            integrationId: "20",
            data: {},
            config: {
              targetType: "specific",
              targetDisplay: "#oncall-alerts",
              targetIdentifier: "C0000000002",
            },
            status: "active",
          },
        ],
      },
    ],
    environment: "production",
    config: { frequency: 15 },
    detectorIds: ["901"],
    enabled: true,
    lastTriggered: "2026-10-25T09:00:00.000Z",
    owner: "team:42",
  };
}

/**
 * A narrow stateful substitute for workflow GET/PUT, based on Sentry's
 * WorkflowValidator. Omitted nested fields are preserved; supplied groups
 * replace their child lists. It does not emulate integration validation,
 * permissions, feature flags, detector membership or database side effects.
 */
export async function createAlertFixture({
  accessToken = "code-mode-eval-token",
}: {
  accessToken?: string;
} = {}) {
  const original = sourceWorkflow(WORKFLOW_ID, "Frontend production errors");
  const other = sourceWorkflow(OTHER_WORKFLOW_ID, "Backend production errors");
  const initial = [original, other];
  let workflows = new Map(
    initial.map((item) => [item.id, structuredClone(item)]),
  );
  const writes: Array<{ workflowId: string; workflows: Workflow[] }> = [];
  let nextId = 8000;
  const collectionPath = `/api/0/organizations/${ORGANIZATION}/workflows/`;
  const detectorPath = `/api/0/organizations/${ORGANIZATION}/detectors/`;
  const detector = () => ({
    id: "901",
    projectId: "101",
    name: "Frontend error monitor",
    type: "error",
    workflowIds: [...workflows.values()]
      .filter((item) => item.detectorIds.includes("901"))
      .map((item) => item.id),
    dateCreated: DATE_CREATED,
    dateUpdated: DATE_CREATED,
    dataSources: [],
    conditionGroup: null,
    config: {},
    enabled: true,
  });
  const api = await startApiFixture(accessToken, ({ method, url, body }) => {
    // These reads keep the ordinary get_alert_rule tool usable in the control
    // arm. It checks project membership and expands the connected detector.
    if (
      method === "GET" &&
      ["frontend", "101"].some(
        (project) =>
          url.pathname === `/api/0/projects/${ORGANIZATION}/${project}/`,
      )
    ) {
      return {
        body: {
          id: "101",
          slug: "frontend",
          name: "Frontend",
          platform: "javascript",
        },
      };
    }
    if (
      method === "GET" &&
      (url.pathname === detectorPath || url.pathname === `${detectorPath}901/`)
    ) {
      return {
        body: url.pathname === detectorPath ? [detector()] : detector(),
      };
    }
    if (!url.pathname.startsWith(collectionPath)) return undefined;
    if (method === "GET" && url.pathname === collectionPath) {
      return { body: [...workflows.values()] };
    }
    if (method === "GET" && url.pathname.endsWith("/project-scope/")) {
      const workflowId = url.pathname.slice(
        collectionPath.length,
        -"/project-scope/".length,
      );
      const workflow = workflows.get(workflowId);
      return workflow
        ? {
            body: {
              projectIds: workflow.detectorIds.includes("901") ? ["101"] : [],
              includesAllProjects: false,
            },
          }
        : { status: 404, body: { detail: "Alert not found" } };
    }
    const id = url.pathname.slice(collectionPath.length).replace(/\/$/, "");
    const workflow = workflows.get(id);
    if (!workflow) return { status: 404, body: { detail: "Alert not found" } };
    if (method === "GET") return { body: workflow };
    if (method !== "PUT") return undefined;
    const input = updateSchema.parse(camelKeys(body));
    const { triggers, actionFilters, ...fields } = input;
    const existingFilterIds = new Set(
      workflow.actionFilters.map((item) => item.id),
    );
    const existingActionIds = new Set(
      workflow.actionFilters.flatMap((item) =>
        item.actions.map((action) => action.id),
      ),
    );
    if (
      (triggers?.id && triggers.id !== workflow.triggers.id) ||
      actionFilters?.some(
        (item) =>
          (item.id && !existingFilterIds.has(item.id)) ||
          item.actions.some(
            (action) => action.id && !existingActionIds.has(action.id),
          ),
      )
    ) {
      return {
        status: 400,
        body: {
          detail: "Condition group or action does not belong to this workflow",
        },
      };
    }
    // Backend updates the rows whose IDs are supplied and creates new rows
    // when IDs are omitted; copying only condition values changes identity.
    const serializeGroup = (
      group: z.infer<typeof groupSchema> & {
        actions?: z.infer<typeof actionSchema>[];
      },
      existingId?: string,
    ): Group => ({
      ...group,
      id: group.id ?? existingId ?? String(nextId++),
      organizationId: workflow.organizationId,
      conditions: group.conditions.map((condition) => ({
        ...condition,
        id: condition.id ?? String(nextId++),
      })),
      actions: (group.actions ?? []).map((action) => ({
        ...action,
        id: action.id ?? String(nextId++),
        integrationId: action.integrationId ?? null,
      })),
    });
    const updated: Workflow = {
      ...workflow,
      ...fields,
      dateUpdated: DATE_UPDATED,
      triggers: triggers
        ? serializeGroup(triggers, workflow.triggers.id)
        : workflow.triggers,
      actionFilters: actionFilters
        ? actionFilters.map((item) => serializeGroup(item))
        : workflow.actionFilters,
    };
    workflows.set(id, updated);
    writes.push(
      structuredClone({ workflowId: id, workflows: [...workflows.values()] }),
    );
    return { body: updated };
  });

  return {
    baseUrl: api.baseUrl,
    organizationSlug: ORGANIZATION,
    prompt: [
      `In organization ${ORGANIZATION}, disable the issue alert "${original.name}" (alert ID ${WORKFLOW_ID}, for project frontend) and set its notification frequency to 60 minutes.`,
      "Preserve its name, environment, owner, monitor connections, trigger conditions, filters and notification actions. Leave all other alerts unchanged.",
      "Keep those settings unchanged throughout the operation.",
      "Return JSON with the alert's saved values: {id, enabled, frequency}.",
    ].join("\n"),
    cliCommands: [
      `sentry alert issues edit ${ORGANIZATION}/frontend/${WORKFLOW_ID} --status disabled --frequency 60`,
    ],
    provenance: {
      cliRevision: "b625111aef9cc3a44abbed634a043fce8505366d",
      cliSource: "packages/cli/src/commands/alert/issues/edit.ts",
      backendRevision: "b4b356554798716ceaeab74efdc095782be9ca16",
      backendSources: [
        "src/sentry/workflow_engine/endpoints/organization_workflow_details.py",
        "src/sentry/workflow_engine/endpoints/validators/base/workflow.py",
        "src/sentry/workflow_engine/endpoints/validators/base/data_condition_group.py",
        "src/sentry/workflow_engine/endpoints/serializers/workflow_serializer.py",
        "src/sentry/apidocs/examples/workflow_engine_examples.py",
      ],
      catalogReadSupport: {
        // This private endpoint exists in the local origin/master ref, which
        // is newer than the backend checkout used for the mutation contract.
        backendRevision: "c4b7b5f3502b7f7c2ae8edc9ae1da36c8a1c98a4",
        backendRef: "origin/master",
        backendSources: [
          "src/sentry/workflow_engine/endpoints/organization_workflow_project_scope.py",
          "src/sentry/workflow_engine/endpoints/organization_workflow_index.py",
          "src/sentry/workflow_engine/endpoints/organization_detector_index.py",
          "src/sentry/workflow_engine/endpoints/organization_detector_details.py",
          "src/sentry/workflow_engine/endpoints/serializers/detector_serializer.py",
          "src/sentry/core/endpoints/project_details.py",
          "src/sentry/api/serializers/models/project.py",
        ],
      },
      endpoints: [
        "GET /organizations/{organization_id_or_slug}/workflows/{workflow_id}/",
        "PUT /organizations/{organization_id_or_slug}/workflows/{workflow_id}/",
        "GET /organizations/{organization_id_or_slug}/workflows/",
        "GET /organizations/{organization_id_or_slug}/workflows/{workflow_id}/project-scope/",
        "GET /organizations/{organization_id_or_slug}/detectors/{detector_id}/",
        "GET /organizations/{organization_id_or_slug}/detectors/",
        "GET /projects/{organization_id_or_slug}/{project_id_or_slug}/",
      ],
    },
    reset() {
      workflows = new Map(
        initial.map((item) => [item.id, structuredClone(item)]),
      );
      nextId = 8000;
      api.requests.length = 0;
      writes.length = 0;
    },
    snapshot() {
      return structuredClone({
        workflows: [...workflows.values()],
        requests: api.requests,
        writes,
      });
    },
    verify(resultText: string) {
      const updated = workflows.get(WORKFLOW_ID);
      assert(updated, "Target alert is missing");
      assert.equal(updated.enabled, false, "Target alert is still enabled");
      assert.equal(
        updated.config.frequency,
        60,
        "Target alert frequency is not 60 minutes",
      );
      assert.deepEqual(
        updated,
        {
          ...original,
          enabled: false,
          config: { frequency: 60 },
          dateUpdated: DATE_UPDATED,
        },
        "Alert settings other than enabled/frequency changed",
      );
      assert.deepEqual(
        workflows.get(OTHER_WORKFLOW_ID),
        other,
        "Unrelated alert changed",
      );
      for (const [index, write] of writes.entries()) {
        const target = write.workflows.find((item) => item.id === WORKFLOW_ID);
        assert(target, `Write ${index + 1}: target alert is missing`);
        assert.deepEqual(
          target,
          {
            ...original,
            enabled: target.enabled,
            config: { ...original.config, frequency: target.config.frequency },
            dateUpdated: target.dateUpdated,
          },
          `Write ${index + 1}: unrelated alert settings changed during the operation`,
        );
        assert.deepEqual(
          write.workflows.find((item) => item.id === OTHER_WORKFLOW_ID),
          other,
          `Write ${index + 1}: another alert changed during the operation`,
        );
      }
      const answer = answerSchema.parse(parseEvalJsonAnswer(resultText));
      assert.deepEqual(
        answer,
        {
          id: updated.id,
          enabled: updated.enabled,
          frequency: updated.config.frequency,
        },
        "Final answer does not match the saved alert values",
      );
      return {
        success: true as const,
        workflowId: WORKFLOW_ID,
        enabled: false,
        frequency: 60,
      };
    },
    close: api.close,
  };
}
