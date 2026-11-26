/**
 * Ask whether the SDK should collect less personal data, for the
 * `dataCollection` option the wizards write into `Sentry.init()`.
 */

import { clack } from "./clack/prompts.js";
import { Sentry } from "../telemetry.js";
import chalk from "chalk";

import { traceStep } from "../telemetry.js";
import { abortIfCancelled } from "./clack/index.js";
import { getMajorVersion } from "./semver.js";

export const DATA_COLLECTION_DOCS_URL =
  "https://docs.sentry.io/platforms/javascript/configuration/options/#dataCollection";

/**
 * Keys that commonly reveal user identity in HTTP headers, cookies, and URL
 * query parameters (forwarding chains, IP addresses, user hints).
 */
const PII_KEY_DENYLIST = ["forwarded", "-ip", "remote-", "via", "-user"];

const PII_KEY_DENYLIST_SNIPPET = `[${PII_KEY_DENYLIST.map(
  (key) => `"${key}"`,
).join(", ")}]`;

/**
 * `dataCollection` value the wizard writes when the user opts to reduce data
 * collection. Kept as an object so magicast-based wizards can insert it as an
 * AST node; `getDataCollectionSnippet` renders the same preset for
 * template-string-based wizards.
 */
export const DATA_COLLECTION_PII_PRESET = {
  userInfo: false,
  graphQL: { document: false, variables: false },
  genAI: { inputs: false, outputs: false },
  databaseQueryData: false,
  queues: false,
  httpBodies: [],
  httpHeaders: { deny: [...PII_KEY_DENYLIST] },
  cookies: { deny: [...PII_KEY_DENYLIST] },
  urlQueryParams: { deny: [...PII_KEY_DENYLIST] },
};

export const DATA_COLLECTION_COMMENT_LINES = [
  "Turns off collection of data that could identify users. Adjust per category:",
  DATA_COLLECTION_DOCS_URL,
];

/**
 * Renders the PII preset (with its explanatory comment) as code to embed in a
 * generated `Sentry.init` options object. Every line is prefixed with
 * `indent`; the result ends without a trailing newline.
 */
export function getDataCollectionSnippet(indent = "  "): string {
  const lines = [
    ...DATA_COLLECTION_COMMENT_LINES.map((line) => `// ${line}`),
    "dataCollection: {",
    "  userInfo: false,",
    "  graphQL: { document: false, variables: false },",
    "  genAI: { inputs: false, outputs: false },",
    "  databaseQueryData: false,",
    "  queues: false,",
    "  httpBodies: [],",
    `  httpHeaders: { deny: ${PII_KEY_DENYLIST_SNIPPET} },`,
    `  cookies: { deny: ${PII_KEY_DENYLIST_SNIPPET} },`,
    `  urlQueryParams: { deny: ${PII_KEY_DENYLIST_SNIPPET} },`,
    "},",
  ];

  return lines.map((line) => `${indent}${line}`).join("\n");
}

/**
 * The `dataCollection` option only makes sense to offer from SDK v11 on,
 * where the SDK collects rich context by default. Unknown or unparseable
 * installed versions fall back to the major of the range the wizard installs.
 */
export function sdkSupportsDataCollection(
  installedSdkVersion: string | undefined,
  wizardInstallRange: string,
): boolean {
  const sdkMajor =
    getMajorVersion(installedSdkVersion) ??
    getMajorVersion(wizardInstallRange) ??
    0;

  return sdkMajor >= 11;
}

/**
 * Asks whether the wizard should write the PII-reducing `dataCollection`
 * preset. Call this only when `sdkSupportsDataCollection` returned `true`.
 */
export async function askShouldReduceDataCollection(): Promise<boolean> {
  return await traceStep("data-collection", async () => {
    const reduceDataCollection: boolean = await abortIfCancelled(
      clack.select({
        message:
          "Sentry collects request data, user info, and other context by default. Do you want to reduce this to avoid sending personally identifiable information (PII)?\n" +
          `More info: ${chalk.cyan(DATA_COLLECTION_DOCS_URL)}`,
        initialValue: false,
        options: [
          {
            value: true,
            label: "Yes",
            hint: "Add a dataCollection config to Sentry.init() that turns off PII-heavy categories",
          },
          {
            value: false,
            label: "No",
            hint: "Keep the SDK defaults",
          },
        ],
      }),
    );

    Sentry.setTag("data-collection-reduced", reduceDataCollection);

    return reduceDataCollection;
  });
}
