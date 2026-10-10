/** Resolve installed App forms; every link mutation uses the backend's canonical-URL guard. */
import { z } from "zod";
import type { SentryApiService } from "../../../api-client";
import { ApiClientError } from "../../../api-client/errors";
import { SentryAppExternalRequestOptionsSchema } from "../../../api-client/schema";
import { UserInputError } from "../../../errors";

type FormValues = Record<string, string | number>;
export type AppIssueLinkParams = {
  organizationSlug: string;
  issueId: string;
  projectId?: string;
  externalIssueUrl: string;
  appSlug?: string;
  fields?: FormValues;
};
type AppIssueLinkApi = Pick<
  SentryApiService,
  | "listSentryAppInstallations"
  | "listSentryAppComponents"
  | "getIssueExternalLinks"
  | "getSentryAppExternalRequestOptions"
  | "linkSentryAppExternalIssue"
  | "unlinkSentryAppExternalIssue"
>;

const FieldSchema = z.object({
  name: z.string().min(1),
  type: z.enum(["select", "text", "textarea"]),
  choices: SentryAppExternalRequestOptionsSchema.shape.choices.optional(),
  options: SentryAppExternalRequestOptionsSchema.shape.choices.optional(),
  defaultValue:
    SentryAppExternalRequestOptionsSchema.shape.defaultValue.nullable(),
  depends_on: z.array(z.string()).optional(),
  multiple: z.boolean().optional(),
  uri: z.string().optional(),
});
const LinkFormSchema = z.object({
  uri: z.string(),
  required_fields: z.array(FieldSchema).default([]),
  optional_fields: z.array(FieldSchema).default([]),
});
type LinkForm = z.infer<typeof LinkFormSchema>;
type Field = z.infer<typeof FieldSchema>;
const RESERVED_FIELDS = new Set([
  "groupId",
  "action",
  "uri",
  "expectedExternalIssueUrl",
  "__proto__",
  "constructor",
  "prototype",
]);
const TARGET_FIELD =
  /^(issue_?id|issue|external_?issue|external_?id|issue_?url|url)$/i;

function isIssueKey(value: string, key: string): boolean {
  return (/^\d+$/.test(key) ? /^\d+$/ : /^[A-Z][A-Z0-9]*-\d+$/i).test(value);
}

function choiceLabelKey(label: string | number): string {
  return String(label)
    .toUpperCase()
    .split(/[^A-Z0-9-]+/)[0]!;
}

function parseTarget(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UserInputError("externalIssueUrl must be a valid HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  ) {
    throw new UserInputError(
      "externalIssueUrl must be an HTTP(S) URL without credentials.",
    );
  }
  const linear =
    url.hostname === "linear.app"
      ? /^\/([^/]+)\/issue\/([a-z][a-z0-9]*-\d+)(?:\/|$)/i.exec(url.pathname)
      : null;
  const shortcut = ["app.shortcut.com", "shortcut.com"].includes(url.hostname)
    ? /^\/([^/]+)\/story\/(\d+)(?:\/|$)/.exec(url.pathname)
    : null;
  const match = linear ?? shortcut;
  return {
    appSlug: linear ? "linear" : shortcut ? "shortcut" : undefined,
    key: match?.[2]?.toUpperCase(),
    // Titles are irrelevant to an existing association's identity, but the
    // original URL is still required for the backend's exact callback guard.
    identity: match
      ? `${url.origin}/${match[1]}/${match[2]?.toUpperCase()}`
      : url.href,
  };
}

export function inferAppSlug(url: string): string | undefined {
  return parseTarget(url).appSlug;
}

export function areEquivalentAppIssueUrls(a: string, b: string): boolean {
  try {
    return parseTarget(a).identity === parseTarget(b).identity;
  } catch {
    return false;
  }
}

function validateUri(uri: string): string {
  if (!/^\/(?!\/)[^@\\\r\n]*$/.test(uri)) {
    throw new UserInputError(
      "The installed App's issue-link form has an invalid callback URI.",
    );
  }
  return uri;
}

function validateFields(
  form: LinkForm,
  supplied: FormValues,
): Map<string, Field> {
  const fields = new Map<string, Field>();
  for (const field of [...form.required_fields, ...form.optional_fields]) {
    if (RESERVED_FIELDS.has(field.name) || fields.has(field.name)) {
      throw new UserInputError(
        "The installed App's issue-link form has unsafe or duplicate fields.",
      );
    }
    fields.set(field.name, field);
  }
  for (const name of Object.keys(supplied)) {
    if (!fields.has(name)) {
      throw new UserInputError(
        `Field '${name}' is not allowed by the installed App's link form.`,
      );
    }
  }
  return fields;
}

async function resolveFields(
  api: AppIssueLinkApi,
  params: AppIssueLinkParams,
  installationUuid: string,
  form: LinkForm,
  fields: Map<string, Field>,
): Promise<FormValues> {
  const supplied = params.fields ?? {};
  const candidates = [...fields.values()].filter((field) =>
    TARGET_FIELD.test(field.name),
  );
  const target =
    candidates.length === 1
      ? candidates[0]
      : candidates.length === 0 && form.required_fields.length === 1
        ? form.required_fields[0]
        : undefined;
  if (!target) {
    throw new UserInputError(
      "Cannot identify the App's existing-issue field. Use the App's Sentry UI to link this issue.",
    );
  }
  const key = parseTarget(params.externalIssueUrl).key;
  const values: FormValues = {};
  const pending = new Set(form.required_fields.map((field) => field.name));
  pending.add(target.name);
  for (const field of fields.values()) {
    const value = supplied[field.name] ?? field.defaultValue;
    if (value != null && value !== "") pending.add(field.name);
  }
  // Resolve required dependencies too, even when the form marks them optional.
  for (const name of pending) {
    const field = fields.get(name);
    if (!field)
      throw new UserInputError(
        `The App's link form references unknown field '${name}'.`,
      );
    for (const dependency of field.depends_on ?? []) pending.add(dependency);
  }
  while (pending.size > 0) {
    let progressed = false;
    for (const name of pending) {
      const field = fields.get(name)!;
      const dependencies = field.depends_on ?? [];
      if (dependencies.some((dependency) => pending.has(dependency))) continue;
      if (field.multiple)
        throw new UserInputError(
          `The App's multiple-choice field '${name}' is not supported.`,
        );
      const isTarget = name === target.name;
      const targetKey = isTarget ? key : undefined;
      const isTargetUrl = isTarget && /url/i.test(name);
      let value: string | number | undefined =
        supplied[name] ??
        (targetKey || isTargetUrl
          ? undefined
          : (field.defaultValue ?? undefined));
      const search = isTarget
        ? isTargetUrl
          ? params.externalIssueUrl
          : (key ?? value ?? params.externalIssueUrl)
        : value;
      if (field.type === "select") {
        let choices = field.choices ?? field.options ?? [];
        if (field.uri) {
          const options = await api.getSentryAppExternalRequestOptions({
            installationUuid,
            uri: validateUri(field.uri),
            query: search === undefined ? undefined : String(search),
            projectId: params.projectId,
            dependentData: dependencies.length
              ? Object.fromEntries(
                  dependencies.map((dependency) => [
                    dependency,
                    values[dependency]!,
                  ]),
                )
              : undefined,
          });
          choices = options.choices;
          if (!targetKey && !isTargetUrl) value ??= options.defaultValue;
        }
        const wanted = value ?? search;
        const matches = choices.filter(
          ([choiceValue, label]) =>
            String(choiceValue) === String(wanted) ||
            String(label) === String(wanted) ||
            (isTarget &&
              key !== undefined &&
              choiceLabelKey(label) === key &&
              (value === undefined || String(choiceValue) === String(value))),
        );
        if (matches.length !== 1) {
          throw new UserInputError(
            `Provide an unambiguous value for App link field '${name}' in fields.`,
          );
        }
        if (targetKey) {
          const [selectedValue, selectedLabel] = matches[0]!;
          const valueKey = String(selectedValue).toUpperCase();
          const labelKey = choiceLabelKey(selectedLabel);
          const identifiedChoices = choices.filter(
            ([choiceValue, label]) =>
              String(choiceValue).toUpperCase() === targetKey ||
              choiceLabelKey(label) === targetKey,
          );
          if (
            (isIssueKey(valueKey, targetKey) && valueKey !== targetKey) ||
            (!isIssueKey(valueKey, targetKey) &&
              ((identifiedChoices.length &&
                !identifiedChoices.some(
                  ([choiceValue]) => choiceValue === selectedValue,
                )) ||
                (isIssueKey(labelKey, targetKey) && labelKey !== targetKey)))
          ) {
            throw new UserInputError(
              `App link field '${name}' conflicts with externalIssueUrl.`,
            );
          }
        }
        value = matches[0]![0];
      } else {
        value ??= search;
        if (
          isTarget &&
          value !== undefined &&
          (((isTargetUrl || /^https?:\/\//i.test(String(value))) &&
            !areEquivalentAppIssueUrls(
              String(value),
              params.externalIssueUrl,
            )) ||
            (targetKey &&
              isIssueKey(String(value), targetKey) &&
              String(value).toUpperCase() !== targetKey))
        ) {
          throw new UserInputError(
            `App link field '${name}' conflicts with externalIssueUrl.`,
          );
        }
      }
      if (value === undefined || value === "") {
        throw new UserInputError(
          `Provide required App link field '${name}' in fields.`,
        );
      }
      values[name] = value;
      pending.delete(name);
      progressed = true;
    }
    if (!progressed)
      throw new UserInputError(
        "The App's link form has circular field dependencies.",
      );
  }
  return values;
}

/** Prepare a complete form even on retries, since an existing association may disappear. */
export async function linkAppIssue(
  api: AppIssueLinkApi,
  params: AppIssueLinkParams,
) {
  const appSlug = params.appSlug ?? inferAppSlug(params.externalIssueUrl);
  if (!appSlug)
    throw new UserInputError("Provide appSlug for this external issue URL.");
  const [installations, components, links] = await Promise.all([
    api.listSentryAppInstallations(params),
    api.listSentryAppComponents(params),
    api.getIssueExternalLinks(params),
  ]);
  const installed = installations.filter(
    (installation) =>
      installation.app.slug === appSlug && installation.status === "installed",
  );
  if (installed.length !== 1)
    throw new UserInputError(`Expected one installed Sentry App '${appSlug}'.`);
  const installation = installed[0]!;
  const matchingComponents = components.filter(
    (component) =>
      component.type === "issue-link" &&
      component.sentryApp.slug === appSlug &&
      (!installation.app.uuid ||
        component.sentryApp.uuid === installation.app.uuid),
  );
  const component =
    matchingComponents.length === 1 ? matchingComponents[0] : undefined;
  const parsed = LinkFormSchema.safeParse(component?.schema.link);
  if (!component || component.error || !parsed.success) {
    throw new UserInputError(
      `Sentry App '${appSlug}' has no usable existing-issue link form.`,
    );
  }
  const uri = validateUri(parsed.data.uri);
  const fields = validateFields(parsed.data, params.fields ?? {});
  const existing = links.filter((link) => link.serviceType === appSlug);
  if (
    existing.length > 1 ||
    (existing[0] &&
      !areEquivalentAppIssueUrls(existing[0].webUrl, params.externalIssueUrl))
  ) {
    throw new UserInputError(
      `This Sentry issue is already linked to another '${appSlug}' issue. Unlink it explicitly before linking a replacement.`,
    );
  }
  const expectedExternalIssueUrl =
    existing[0]?.webUrl ?? params.externalIssueUrl;
  // A concurrent unlink can make even a repeated action invoke the callback.
  const values = await resolveFields(
    api,
    params,
    installation.uuid,
    parsed.data,
    fields,
  );
  try {
    const result = await api.linkSentryAppExternalIssue({
      installationUuid: installation.uuid,
      issueId: params.issueId,
      uri,
      fields: values,
      expectedExternalIssueUrl,
    });
    return {
      url: result.issue.webUrl,
      displayName: result.issue.displayName,
      provider: appSlug,
      status: result.changed
        ? ("linked" as const)
        : ("already_linked" as const),
    };
  } catch (error) {
    if (error instanceof ApiClientError && error.status === 409) {
      throw new UserInputError(
        "The App link conflicted with the current association or callback URL. Check the current link and use the provider's exact canonical issue URL, including its title path. Unlink an existing different issue explicitly before replacing it; retry if another link operation was in progress.",
        { cause: error },
      );
    }
    throw error;
  }
}

/** Remove the matching App association by ID without invoking the provider. */
export async function unlinkAppIssue(
  api: AppIssueLinkApi,
  params: AppIssueLinkParams,
) {
  const appSlug = params.appSlug ?? inferAppSlug(params.externalIssueUrl);
  const links = await api.getIssueExternalLinks(params);
  const matches = links.filter(
    (link) =>
      (!appSlug || link.serviceType === appSlug) &&
      areEquivalentAppIssueUrls(link.webUrl, params.externalIssueUrl),
  );
  if (matches.length > 1)
    throw new UserInputError(
      "Multiple App links match this URL. Provide appSlug to select one.",
    );
  const match = matches[0];
  if (!match)
    return {
      url: params.externalIssueUrl,
      provider: appSlug,
      status: "not_linked" as const,
    };
  await api.unlinkSentryAppExternalIssue({
    ...params,
    externalIssueId: String(match.id),
  });
  return {
    url: match.webUrl,
    displayName: match.displayName,
    provider: match.serviceType,
    status: "not_linked" as const,
  };
}
