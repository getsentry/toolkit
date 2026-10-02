/**
 * Link existing tracker issues through installed Sentry Apps' issue-link forms.
 * App callbacks and search URIs come only from the installed component schema.
 */

import {
  executeSentryAppInstallationExternalIssueAction,
  type GroupExternalIssueResponse,
  getSentryAppInstallationExternalRequestOptions,
  type ListOrganizationSentryAppInstallationsResponse,
  listOrganizationIssueExternalIssues,
  listOrganizationSentryAppComponents,
  listOrganizationSentryAppInstallations,
} from "@sentry/api";
import {
  vGroupExternalIssueResponse,
  vListOrganizationSentryAppComponentsResponse,
  vListOrganizationSentryAppInstallationsResponse,
} from "@sentry/api/valibot";
import {
  array,
  boolean,
  type InferOutput,
  nullish,
  number,
  object,
  optional,
  picklist,
  safeParse,
  string,
  tuple,
  union,
} from "valibot";
import { ApiError, ValidationError } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import { getControlSiloUrl, getSdkConfig } from "../sentry-client.js";
import { isAllDigits, parseHttpUrl } from "../utils.js";
import {
  fetchAllPages,
  unwrapPaginatedResult,
  unwrapResult,
} from "./infrastructure.js";

/** A stored Sentry App association; id identifies the link, not the remote ticket. */
export type AppIssueLink = GroupExternalIssueResponse[number];
type AppInstallation = ListOrganizationSentryAppInstallationsResponse[number];
const ChoiceSchema = tuple([
  union([string(), number()]),
  union([string(), number()]),
]);
const FieldSchema = object({
  name: string(),
  type: picklist(["select", "text", "textarea"]),
  choices: optional(array(ChoiceSchema)),
  options: optional(array(ChoiceSchema)),
  defaultValue: nullish(union([string(), number()])),
  depends_on: optional(array(string())),
  multiple: optional(boolean()),
  uri: optional(string()),
});
const LinkFormSchema = object({
  uri: string(),
  required_fields: optional(array(FieldSchema)),
  optional_fields: optional(array(FieldSchema)),
});
const ChoicesResponseSchema = object({
  choices: array(ChoiceSchema),
  defaultValue: FieldSchema.entries.defaultValue,
});
type Choice = InferOutput<typeof ChoiceSchema>;
type Field = InferOutput<typeof FieldSchema>;
type LinkForm = InferOutput<typeof LinkFormSchema>;

/** Inputs for a read-only preflight of the app's existing-issue link action. */
export type ResolveAppIssueLinkOptions = {
  /** Organization containing the Sentry issue and app installation. */
  orgSlug: string;
  /** Numeric Sentry group ID, required by external-issue-actions. */
  issueId: string;
  /** Existing external resource URL. */
  url: string;
  /** Installed app slug; defaults to linear for a linear.app issue URL. */
  appSlug?: string;
  /** Sentry project ID, forwarded to app searches that need project context. */
  projectId?: string;
  /** Additional form values keyed by names from the installed link schema. */
  fields?: Record<string, string>;
};

/** Read-only preflight result. Pass to linkAppIssue to execute the app action. */
export type PreparedAppIssueLink = {
  /** Organization and numeric Sentry issue being linked. */
  orgSlug: string;
  /** Numeric Sentry group ID. */
  issueId: string;
  /** Installed app slug and requested external URL for display/dry-run. */
  appSlug: string;
  /** Requested external resource URL. */
  url: string;
  /** UUID selected from this organization's installed apps. */
  installationUuid: string;
  /** Link action URI supplied by the installed app schema. */
  uri: string;
  /** Validated form fields, sent at the top level of the action request. */
  fields: Record<string, string | number>;
  /** Existing association to the same target, supplying the canonical URL guard. */
  existing?: AppIssueLink;
};

const LINEAR_ISSUE_PATH = /^\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/|$)/i;
const TARGET_FIELD =
  /^(issue_?id|issue|external_?issue|external_?id|issue_?url|url)$/i;
const RESERVED_FIELDS = new Set([
  "groupId",
  "action",
  "uri",
  "__proto__",
  "constructor",
  "prototype",
]);
const TRAILING_SLASHES = /\/+$/;
const CHOICE_LABEL_TOKENS = /[^A-Z0-9-]+/;
const LINEAR_ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const URL_FIELD = /url/i;

function parseTarget(raw: string) {
  const url = parseHttpUrl(raw);
  if (!url) {
    throw new ValidationError(
      "External issue must be an absolute HTTP(S) URL without credentials.",
      "url"
    );
  }
  const linear =
    url.hostname === "linear.app" ? LINEAR_ISSUE_PATH.exec(url.pathname) : null;
  if (url.hostname === "linear.app" && !linear) {
    throw new ValidationError(
      "Expected a Linear issue URL containing /issue/TEAM-123",
      "url"
    );
  }
  const identity = linear
    ? `linear.app/${linear[1]?.toLowerCase()}/${linear[2]?.toUpperCase()}`
    : `${url.origin}${url.pathname.replace(TRAILING_SLASHES, "")}${url.search}${url.hash}`;
  return { identity, key: linear?.[2]?.toUpperCase() };
}

/** Match a stored target by URL, ignoring Linear title suffixes; reject ambiguous matches. */
export function findAppIssueLink(
  links: AppIssueLink[],
  url: string,
  appSlug?: string
): AppIssueLink | undefined {
  const target = parseTarget(url);
  const matches = links.filter((link) => {
    if (appSlug && link.serviceType !== appSlug) {
      return false;
    }
    // biome-ignore lint/plugin: Invalid persisted URLs cannot identify the requested target.
    try {
      return parseTarget(link.webUrl).identity === target.identity;
    } catch {
      // A malformed stored sibling must not prevent matching a valid target.
      return false;
    }
  });
  if (matches.length > 1) {
    throw new ValidationError(
      "Multiple app links match this URL; specify the app with --app",
      "app"
    );
  }
  return matches[0];
}

function requireIssueTarget(orgSlug: string, issueId: string): void {
  if (
    !orgSlug ||
    orgSlug === "." ||
    orgSlug === ".." ||
    !isAllDigits(issueId)
  ) {
    throw new ValidationError(
      "App links require an organization and numeric Sentry issue ID",
      "issueId"
    );
  }
}

/** Retrieve all app associations in the issue's region. */
export async function listAppIssueLinks(
  orgSlug: string,
  issueId: string
): Promise<AppIssueLink[]> {
  requireIssueTarget(orgSlug, issueId);
  const config = getSdkConfig(await resolveOrgRegion(orgSlug));
  return fetchAllPages(
    async (cursor) => {
      const result = await listOrganizationIssueExternalIssues({
        ...config,
        path: { organization_id_or_slug: orgSlug, issue_id: issueId },
        query: { cursor },
      });
      return unwrapPaginatedResult(result, "Failed to list app issue links");
    },
    vGroupExternalIssueResponse,
    "listing app issue links"
  );
}

/** Preserve the app's single association per Sentry issue; replacing a target requires explicit unlink. */
function checkExisting(
  links: AppIssueLink[],
  url: string,
  appSlug: string
): AppIssueLink | undefined {
  const existing = findAppIssueLink(links, url, appSlug);
  if (
    links.some(
      (link) => link.serviceType === appSlug && link.id !== existing?.id
    )
  ) {
    throw new ValidationError(
      `This issue already has a different ${appSlug} link. Unlink it before linking another issue.`,
      "app"
    );
  }
  return existing;
}

function validateUri(uri: unknown): asserts uri is string {
  if (
    typeof uri !== "string" ||
    !uri.startsWith("/") ||
    uri.startsWith("//") ||
    uri.includes("\\")
  ) {
    throw new ValidationError(
      "The installed app has an invalid relative action URI",
      "app"
    );
  }
}

async function resolveInstallation(
  orgSlug: string,
  appSlug: string
): Promise<AppInstallation> {
  const config = getSdkConfig(getControlSiloUrl());
  const installations = await fetchAllPages(
    async (cursor) => {
      const result = await listOrganizationSentryAppInstallations({
        ...config,
        path: { organization_id_or_slug: orgSlug },
        query: { cursor },
      });
      return unwrapPaginatedResult(
        result,
        "Failed to list Sentry App installations"
      );
    },
    vListOrganizationSentryAppInstallationsResponse,
    "listing Sentry App installations"
  );
  const matches = installations.filter(
    (item) =>
      item.organization.slug === orgSlug &&
      item.app.slug === appSlug &&
      item.status === "installed"
  );
  const installation = matches[0];
  if (matches.length !== 1 || !installation) {
    throw new ValidationError(
      matches.length
        ? `Multiple installed apps match ${appSlug}`
        : `App ${appSlug} is not installed in this organization`,
      "app"
    );
  }
  return installation;
}

async function getLinkForm(
  orgSlug: string,
  installation: AppInstallation
): Promise<LinkForm> {
  const config = getSdkConfig(getControlSiloUrl());
  const components = await fetchAllPages(
    async (cursor) => {
      const result = await listOrganizationSentryAppComponents({
        ...config,
        path: { organization_id_or_slug: orgSlug },
        query: { filter: "issue-link", cursor },
      });
      return unwrapPaginatedResult(result, "Failed to list app components");
    },
    vListOrganizationSentryAppComponentsResponse,
    "listing Sentry App components"
  );
  const matches = components.filter(
    (item) =>
      item.type === "issue-link" &&
      item.sentryApp.uuid === installation.app.uuid
  );
  const component = matches[0];
  if (matches.length !== 1 || !component) {
    throw new ValidationError(
      `App ${installation.app.slug} does not expose an unambiguous issue-link form`,
      "app"
    );
  }
  if (component.error) {
    throw new ApiError(
      `App ${installation.app.slug} could not prepare its issue-link form`,
      0,
      JSON.stringify(component.error)
    );
  }
  // App-defined form schemas are intentionally untyped in the API contract.
  const form = safeParse(LinkFormSchema, component.schema.link);
  if (!form.success) {
    throw new ValidationError(
      `App ${installation.app.slug} does not expose a supported issue-link form`,
      "app"
    );
  }
  validateUri(form.output.uri);
  return form.output;
}

async function getChoices({
  installationUuid,
  field,
  query,
  values,
  projectId,
}: {
  installationUuid: string;
  field: Field;
  query?: string;
  values: Record<string, string | number>;
  projectId?: string;
}): Promise<InferOutput<typeof ChoicesResponseSchema>> {
  if (!field.uri) {
    return { choices: field.choices ?? field.options ?? [] };
  }
  validateUri(field.uri);
  const dependentData = Object.fromEntries(
    (field.depends_on ?? []).map((name) => [name, values[name]])
  );
  const result = await getSentryAppInstallationExternalRequestOptions({
    ...getSdkConfig(getControlSiloUrl()),
    path: { uuid: installationUuid },
    query: {
      uri: field.uri,
      query,
      projectId: projectId === undefined ? undefined : Number(projectId),
      dependentData: field.depends_on?.length
        ? JSON.stringify(dependentData)
        : undefined,
    },
  });
  const parsed = safeParse(
    ChoicesResponseSchema,
    unwrapResult(result, "Failed to search app issues")
  );
  if (!parsed.success) {
    throw new ApiError("App search returned invalid issue choices", 0);
  }
  return parsed.output;
}

function choiceLabelKey(label: string | number): string | undefined {
  return String(label)
    .toUpperCase()
    .split(CHOICE_LABEL_TOKENS)
    .find((token) => token.length > 0);
}

/** Reject supplied IDs that identify another Linear issue before invoking its callback. */
function validateLinearChoice(
  choice: Choice,
  choices: Choice[],
  key: string
): void {
  const valueKey = String(choice[0]).toUpperCase();
  const labelKey = choiceLabelKey(choice[1]);
  const identified = choices.filter(
    ([value, label]) =>
      String(value).toUpperCase() === key || choiceLabelKey(label) === key
  );
  if (
    (LINEAR_ISSUE_KEY.test(valueKey) && valueKey !== key) ||
    (!LINEAR_ISSUE_KEY.test(valueKey) &&
      ((identified.length &&
        !identified.some(([value]) => value === choice[0])) ||
        (labelKey && LINEAR_ISSUE_KEY.test(labelKey) && labelKey !== key)))
  ) {
    throw new ValidationError(
      "App issue choice conflicts with the requested issue URL",
      "field"
    );
  }
}

function selectChoice(
  choices: Choice[],
  query: string,
  linearKey?: string,
  supplied?: string
): string | number {
  const wanted = supplied ?? query;
  const matches = choices.filter(
    ([value, label]) =>
      String(value) === wanted ||
      String(label) === wanted ||
      (linearKey !== undefined &&
        choiceLabelKey(label) === linearKey &&
        (supplied === undefined ||
          supplied === query ||
          String(value) === supplied))
  );
  const choice = matches[0];
  if (matches.length !== 1 || !choice) {
    const missingMessage =
      supplied && linearKey
        ? "App issue choice conflicts with the requested issue URL"
        : "App search did not return an exact match for the external issue";
    throw new ValidationError(
      matches.length
        ? "App search returned multiple exact issue matches"
        : missingMessage,
      "url"
    );
  }
  if (linearKey) {
    validateLinearChoice(choice, choices, linearKey);
  }
  return choice[0];
}

/** Dependencies are required even when their fields are otherwise optional. */
function addDependencies(pending: Field[], fields: Field[]): void {
  for (const field of pending) {
    for (const name of field.depends_on ?? []) {
      const dependency = fields.find((item) => item.name === name);
      if (dependency && !pending.includes(dependency)) {
        pending.push(dependency);
      }
    }
  }
}

/** Resolve form dependencies while keeping the target field bound to the requested issue URL. */
async function resolveFields(
  options: ResolveAppIssueLinkOptions,
  form: LinkForm,
  installationUuid: string
): Promise<Record<string, string | number>> {
  const required = form.required_fields ?? [];
  const fields = [...required, ...(form.optional_fields ?? [])];
  const values = seedFields(fields, options.fields ?? {});
  const targetField = findTargetField(fields, required);
  const pending = fields.filter(
    (field) =>
      field === targetField ||
      required.includes(field) ||
      values[field.name] !== undefined
  );
  addDependencies(pending, fields);
  const resolved = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex((item) =>
      (item.depends_on ?? []).every((name) => resolved.has(name))
    );
    const field = pending[index];
    if (!field) {
      const missing = new Set(
        pending.flatMap((item) =>
          (item.depends_on ?? []).filter((name) => values[name] === undefined)
        )
      );
      throw new ValidationError(
        missing.size
          ? `Missing app link fields: ${[...missing].map((name) => `--field ${name}=VALUE`).join(", ")}`
          : "App link fields have circular dependencies",
        "field"
      );
    }
    pending.splice(index, 1);
    values[field.name] = await resolveFieldValue({
      field,
      targetField,
      values,
      options,
      installationUuid,
    });
    resolved.add(field.name);
  }
  return values;
}

function seedFields(
  fields: Field[],
  supplied: Record<string, string>
): Record<string, string | number> {
  const values: Record<string, string | number> = {};
  if (new Set(fields.map((field) => field.name)).size !== fields.length) {
    throw new ValidationError(
      "App link schema contains duplicate field names",
      "app"
    );
  }
  for (const [name, value] of Object.entries(supplied)) {
    if (
      RESERVED_FIELDS.has(name) ||
      !fields.some((field) => field.name === name)
    ) {
      throw new ValidationError(
        `Unknown or reserved app link field: ${name}`,
        "field"
      );
    }
    if (value !== "") {
      values[name] = value;
    }
  }
  for (const field of fields) {
    if (RESERVED_FIELDS.has(field.name)) {
      throw new ValidationError(
        `App link schema uses reserved field ${field.name}`,
        "app"
      );
    }
    if (field.multiple) {
      throw new ValidationError(
        `App link field ${field.name} requires multiple values and is not supported`,
        "field"
      );
    }
    if (
      supplied[field.name] === undefined &&
      field.defaultValue !== undefined &&
      field.defaultValue !== null &&
      field.defaultValue !== ""
    ) {
      values[field.name] = field.defaultValue;
    }
  }
  return values;
}

function findTargetField(fields: Field[], required: Field[]): Field {
  const candidates = fields.filter((field) => TARGET_FIELD.test(field.name));
  let targetField = candidates.length === 1 ? candidates[0] : undefined;
  if (candidates.length === 0 && required.length === 1) {
    targetField = required[0];
  }
  if (!targetField) {
    throw new ValidationError(
      "Cannot identify one external issue field in the app link schema",
      "app"
    );
  }
  return targetField;
}

/** Required fields and dependencies need a value; explicit target values must agree. */
function validateFieldValue(
  fieldName: string,
  value: string | number | undefined,
  query: string | number | undefined,
  supplied?: string
): asserts value is string | number {
  if (
    supplied !== undefined &&
    supplied !== String(value) &&
    supplied !== query
  ) {
    throw new ValidationError(
      `App field ${fieldName} conflicts with the requested issue URL`,
      "field"
    );
  }
  if (value === undefined || value === "") {
    throw new ValidationError(
      `Missing app link fields: --field ${fieldName}=VALUE`,
      "field"
    );
  }
}

async function resolveFieldValue({
  field,
  targetField,
  values,
  options,
  installationUuid,
}: {
  field: Field;
  targetField: Field;
  values: Record<string, string | number>;
  options: ResolveAppIssueLinkOptions;
  installationUuid: string;
}): Promise<string | number> {
  const isTarget = field === targetField;
  const targetKey = isTarget ? parseTarget(options.url).key : undefined;
  const supplied = isTarget ? options.fields?.[field.name] : undefined;
  // Generic selects can use provider IDs that cannot be inferred from the URL.
  let query = (options.fields?.[field.name] ?? values[field.name])?.toString();
  if (isTarget) {
    query =
      targetKey ??
      (field.type === "select" ? supplied : undefined) ??
      options.url;
  }
  let value: string | number | undefined = query;
  if (field.type === "select") {
    const optionsResponse = await getChoices({
      installationUuid,
      field,
      query,
      values,
      projectId: options.projectId,
    });
    if (!isTarget) {
      value ??= optionsResponse.defaultValue ?? undefined;
    }
    if (value !== undefined) {
      value = selectChoice(
        optionsResponse.choices,
        String(value),
        targetKey,
        supplied
      );
    }
  } else if (isTarget && URL_FIELD.test(field.name)) {
    value = options.url;
  }
  validateFieldValue(field.name, value, query, supplied);
  return value;
}

/** Resolve the installed app and form using reads only; never register a local-only fallback. */
export async function resolveAppIssueLink(
  options: ResolveAppIssueLinkOptions
): Promise<PreparedAppIssueLink> {
  const target = parseTarget(options.url);
  const appSlug = options.appSlug ?? (target.key ? "linear" : undefined);
  if (!appSlug) {
    throw new ValidationError(
      "Specify --app for this external issue URL",
      "app"
    );
  }
  const existing = checkExisting(
    await listAppIssueLinks(options.orgSlug, options.issueId),
    options.url,
    appSlug
  );
  const installation = await resolveInstallation(options.orgSlug, appSlug);
  const form = await getLinkForm(options.orgSlug, installation);
  return {
    orgSlug: options.orgSlug,
    issueId: options.issueId,
    appSlug,
    url: options.url,
    installationUuid: installation.uuid,
    uri: form.uri,
    fields: await resolveFields(options, form, installation.uuid),
    existing,
  };
}

/** Execute the callback with the backend's atomic no-op and replacement guard. */
export async function linkAppIssue(
  prepared: PreparedAppIssueLink
): Promise<{ link: AppIssueLink; changed: boolean }> {
  validateUri(prepared.uri);
  const result = await executeSentryAppInstallationExternalIssueAction({
    ...getSdkConfig(getControlSiloUrl()),
    path: { uuid: prepared.installationUuid },
    query: {
      expectedExternalIssueUrl: prepared.existing?.webUrl ?? prepared.url,
    },
    body: {
      ...prepared.fields,
      groupId: prepared.issueId,
      action: "link",
      uri: prepared.uri,
    },
  });
  return {
    link: unwrapResult(result, "Failed to link app issue"),
    changed: result.response?.status === 201,
  };
}
