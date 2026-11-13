import { z } from "zod";
import type { ClientKey, SentryApiService } from "../../api-client/index";
import { UserInputError } from "../../errors";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamOrganizationSlug,
  ParamPlatform,
  ParamProjectSlug,
  ParamRegionUrl,
  ParamTeamSlug,
} from "../../schema";
import { logWarn } from "../../telem/logging";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

export const createProjectOutputSchema = z.object({
  project: z.object({
    id: z.string(),
    slug: z.string(),
    name: z.string(),
  }),
  dsn: z
    .string()
    .nullable()
    .describe(
      "Public DSN (SENTRY_DSN) for SDK initialization, or null when key setup failed.",
    ),
  repository: z
    .object({
      name: z.string(),
      linked: z.boolean(),
    })
    .nullable(),
});

type RepositoryMatch = {
  name: string;
  provider: {
    id: string;
  };
};

function getUsableClientKey(clientKeys: ClientKey[]): ClientKey | undefined {
  return (
    clientKeys.find(
      (key) => key.name === "Default" && key.isActive && key.dsn.public,
    ) ?? clientKeys.find((key) => key.isActive && key.dsn.public)
  );
}

function findRepositoryMatch(
  repositories: RepositoryMatch[],
  repository: string,
): RepositoryMatch {
  const exactMatches = repositories.filter(
    (candidate) => candidate.name === repository,
  );
  const matches =
    exactMatches.length > 0 || repository.includes("/")
      ? exactMatches
      : repositories.filter((candidate) =>
          candidate.name.endsWith(`/${repository}`),
        );

  if (matches.length === 0) {
    throw new UserInputError(
      `Could not find repository "${repository}" in the organization. Make sure it is connected through a VCS integration before creating the project.`,
    );
  }

  if (matches.length > 1) {
    throw new UserInputError(
      `Repository "${repository}" matched multiple repositories. Provide the full repository name, such as owner/repo.`,
    );
  }

  return matches[0];
}

function getRepositoryProvider(repository: RepositoryMatch): string | null {
  return repository.provider.id.replace(/^integrations:/, "") || null;
}

async function getOrCreateClientKey({
  apiService,
  organizationSlug,
  projectSlug,
}: {
  apiService: SentryApiService;
  organizationSlug: string;
  projectSlug: string;
}): Promise<ClientKey | null> {
  let clientKey: ClientKey | undefined;

  try {
    clientKey = getUsableClientKey(
      await apiService.listClientKeys({
        organizationSlug,
        projectSlug,
      }),
    );
  } catch (err) {
    logWarn(err, {
      loggerScope: ["runtime", "project-management"],
      extra: { action: "list_project_client_keys" },
    });
  }

  if (clientKey) {
    return clientKey;
  }

  try {
    return await apiService.createClientKey({
      organizationSlug,
      projectSlug,
      name: "Default",
    });
  } catch (err) {
    logWarn(err, {
      loggerScope: ["runtime", "project-management"],
      extra: { action: "create_project_client_key" },
    });
    return null;
  }
}

export default defineTool({
  name: "create_project",
  title: "Create Project",
  skills: ["project-management"], // Only available in project-management skill
  requiredScopes: ["project:write", "team:read", "org:read"],
  description:
    "Create a new Sentry project for an app or service and provision its DSN (client key) for SDK setup. Optionally links a connected repository with a root code mapping. Returns the project, its DSN, and whether the repository linked.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    teamSlug: ParamTeamSlug,
    name: z
      .string()
      .trim()
      .describe("Display name, usually the app or service name."),
    slug: ParamProjectSlug.describe(
      "Project slug. Sentry derives one from the name when omitted.",
    )
      .nullable()
      .default(null),
    platform: ParamPlatform.nullable().default(null),
    repository: z
      .string()
      .trim()
      .nullable()
      .default(null)
      .describe(
        "Repository to link, as `owner/repo`. Must already be connected to the organization through a VCS integration.",
      ),
  },
  outputSchema: createProjectOutputSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const organizationSlug = params.organizationSlug;

    setTargetTagsAndAttributes(params);

    // Resolve repository intent before creating the project so bad or ambiguous
    // repo input cannot leave behind an otherwise unwanted project.
    const repositoryMatch = params.repository
      ? findRepositoryMatch(
          await apiService.listRepos({
            organizationSlug,
          }),
          params.repository,
        )
      : null;

    const project = await apiService.createProject({
      organizationSlug,
      teamSlug: params.teamSlug,
      name: params.name,
      slug: params.slug,
      platform: params.platform,
    });

    let repositoryLinked = false;
    if (repositoryMatch) {
      try {
        const repositoryMapping = await apiService.linkProjectRepository({
          organizationSlug,
          projectSlug: project.slug,
          repository: repositoryMatch.name,
          provider: getRepositoryProvider(repositoryMatch),
        });
        repositoryLinked =
          repositoryMapping.errors === 0 &&
          repositoryMapping.mappings.some((mapping) =>
            ["created", "updated"].includes(mapping.status),
          );
      } catch (err) {
        // Repository linking happens after project creation; preserve the
        // project + DSN response and report the link failure in the output.
        logWarn(err, {
          loggerScope: ["runtime", "project-management"],
          extra: { action: "link_project_repository" },
        });
      }
    }

    const clientKey = await getOrCreateClientKey({
      apiService,
      organizationSlug,
      projectSlug: project.slug,
    });
    return structuredResult({
      project: {
        id: String(project.id),
        slug: project.slug,
        name: project.name,
      },
      dsn: clientKey?.dsn.public ?? null,
      repository: repositoryMatch
        ? { name: repositoryMatch.name, linked: repositoryLinked }
        : null,
    });
  },
});
