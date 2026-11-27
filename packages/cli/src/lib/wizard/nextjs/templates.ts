/**
 * File and snippet templates the Next.js wizard writes or shows.
 */

import chalk from "chalk";
import { makeCodeSnippet } from "../utils/clack/index.js";
import { getDataCollectionSnippet } from "../utils/data-collection.js";

const DATA_COLLECTION_HINT = `  dataCollection: {
    // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/nextjs/configuration/options/#dataCollection
    // userInfo: false,
    // httpBodies: [],
  },`;

/**
 * The active PII-reducing preset when the user opted in, the commented-out
 * hint otherwise.
 */
function getDataCollectionBlock(reduceDataCollection: boolean): string {
  return reduceDataCollection
    ? getDataCollectionSnippet("  ")
    : DATA_COLLECTION_HINT;
}

/** Root export of the Next.js SDK. Exposes `withSentryConfig` up to SDK v10 only. */
export const SENTRY_NEXTJS_ROOT_IMPORT_PATH = "@sentry/nextjs";

/** Subpath that exposes `withSentryConfig` since SDK 10.73.0 and is the only location in v11. */
export const SENTRY_NEXTJS_CONFIG_IMPORT_PATH = "@sentry/nextjs/config";

type WithSentryConfigOptions = {
  orgSlug: string;
  projectSlug: string;
  selfHosted: boolean;
  sentryUrl: string;
  tunnelRoute: boolean;
};

export function getWithSentryConfigOptionsTemplate({
  orgSlug,
  projectSlug,
  selfHosted,
  tunnelRoute,
  sentryUrl,
}: WithSentryConfigOptions): string {
  return `{
  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/sourcemaps/uploading/bundler-plugin-options/

  org: "${orgSlug}",
  project: "${projectSlug}",${
    selfHosted ? `\n  sentryUrl: "${sentryUrl}",` : ""
  }

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // ${
    tunnelRoute ? "Route" : "Uncomment to route"
  } browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  ${tunnelRoute ? "" : "// "}tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
}`;
}

export function getNextjsConfigCjsTemplate(
  withSentryConfigOptionsTemplate: string,
  withSentryConfigImportPath: string = SENTRY_NEXTJS_CONFIG_IMPORT_PATH,
): string {
  return `const { withSentryConfig } = require("${withSentryConfigImportPath}");

/** @type {import('next').NextConfig} */
const nextConfig = {};

module.exports = withSentryConfig(nextConfig, ${withSentryConfigOptionsTemplate});
`;
}

export function getNextjsConfigMjsTemplate(
  withSentryConfigOptionsTemplate: string,
  withSentryConfigImportPath: string = SENTRY_NEXTJS_CONFIG_IMPORT_PATH,
): string {
  return `import { withSentryConfig } from "${withSentryConfigImportPath}";

/** @type {import('next').NextConfig} */
const nextConfig = {};

export default withSentryConfig(nextConfig, ${withSentryConfigOptionsTemplate});
`;
}

export function getNextjsConfigCjsAppendix(
  withSentryConfigOptionsTemplate: string,
  withSentryConfigImportPath: string = SENTRY_NEXTJS_CONFIG_IMPORT_PATH,
): string {
  return `

// Injected content via Sentry wizard below

const { withSentryConfig } = require("${withSentryConfigImportPath}");

module.exports = withSentryConfig(module.exports, ${withSentryConfigOptionsTemplate});
`;
}

export function getNextjsConfigEsmCopyPasteSnippet(
  withSentryConfigOptionsTemplate: string,
  withSentryConfigImportPath: string = SENTRY_NEXTJS_CONFIG_IMPORT_PATH,
): string {
  return `

// next.config.mjs
import { withSentryConfig } from "${withSentryConfigImportPath}";

export default withSentryConfig(yourNextConfig, ${withSentryConfigOptionsTemplate});
`;
}

function getClientIntegrationsSnippet(features: { replay: boolean }) {
  if (features.replay) {
    return `

  // Add optional integrations for additional features
  integrations: [Sentry.replayIntegration()],`;
  }

  return "";
}

function getSpotlightOption(spotlight: boolean): string {
  if (!spotlight) {
    return "";
  }

  return `

  // Spotlight enabled for local development (https://spotlightjs.com)
  spotlight: true,`;
}

export function getSentryServersideConfigContents(
  dsn: string,
  config: "server" | "edge",
  selectedFeaturesMap: {
    replay: boolean;
    performance: boolean;
  },
  reduceDataCollection: boolean,
  spotlight = false,
): string {
  let primer = "";
  if (config === "server") {
    primer = `// This file configures the initialization of Sentry on the server.
// The config you add here will be used whenever the server handles a request.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/`;
  } else {
    primer = `// This file configures the initialization of Sentry for edge features (middleware, edge routes, and so on).
// The config you add here will be used whenever one of the edge features is loaded.
// Note that this config is unrelated to the Vercel Edge Runtime and is also required when running locally.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/`;
  }

  let performanceOptions = "";
  if (selectedFeaturesMap.performance) {
    performanceOptions += `

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,`;
  }

  const spotlightOptions = getSpotlightOption(spotlight);
  return `${primer}

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "${dsn}",${performanceOptions}

${getDataCollectionBlock(reduceDataCollection)}${spotlightOptions}
});
`;
}

export function getInstrumentationClientFileContents(
  dsn: string,
  selectedFeaturesMap: {
    replay: boolean;
    performance: boolean;
  },
  reduceDataCollection: boolean,
  spotlight = false,
): string {
  const integrationsOptions = getClientIntegrationsSnippet({
    replay: selectedFeaturesMap.replay,
  });

  let replayOptions = "";

  if (selectedFeaturesMap.replay) {
    replayOptions += `

  // Define how likely Replay events are sampled.
  // This sets the sample rate to be 10%. You may want this to be 100% while
  // in development and sample at a lower rate in production
  replaysSessionSampleRate: 0.1,

  // Define how likely Replay events are sampled when an error occurs.
  replaysOnErrorSampleRate: 1.0,`;
  }

  let performanceOptions = "";
  if (selectedFeaturesMap.performance) {
    performanceOptions += `

  // Define how likely traces are sampled. Adjust this value in production, or use tracesSampler for greater control.
  tracesSampleRate: 1,`;
  }

  const spotlightOptions = getSpotlightOption(spotlight);

  return `// This file configures the initialization of Sentry on the client.
// The added config here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: "${dsn}",${integrationsOptions}${performanceOptions}${replayOptions}

${getDataCollectionBlock(reduceDataCollection)}${spotlightOptions}
});

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
`;
}

export function getSentryExamplePageContents(options: {
  selfHosted: boolean;
  sentryUrl: string;
  orgSlug: string;
  projectId: string;
  useClient: boolean;
  isTypeScript?: boolean | undefined;
}): string {
  const issuesPageLink = options.selfHosted
    ? `${options.sentryUrl}organizations/${options.orgSlug}/issues/?project=${options.projectId}`
    : `https://${options.orgSlug}.sentry.io/issues/?project=${options.projectId}`;

  const loggerPageLoad = `
    Sentry.logger.info("Sentry example page loaded");`;

  const loggerUserAction = `
            Sentry.logger.info("User clicked the button, throwing a sample error");`;

  return `${
    options.useClient ? '"use client";\n\n' : ""
  }import * as Sentry from "@sentry/nextjs";
import Head from "next/head";
import { useEffect, useState } from "react";

class SentryExampleFrontendError extends Error {
  constructor(message${options.isTypeScript ? ": string | undefined" : ""}) {
    super(message);
    this.name = "SentryExampleFrontendError";
  }
}

export default function Page() {
  const [hasSentError, setHasSentError] = useState(false);
  const [isConnected, setIsConnected] = useState(true);

  useEffect(() => {${loggerPageLoad}
    async function checkConnectivity() {
      const result = await Sentry.diagnoseSdkConnectivity();
      setIsConnected(result !== "sentry-unreachable");
    }
    checkConnectivity();
  }, []);

  return (
    <div>
      <Head>
        <title>sentry-example-page</title>
        <meta name="description" content="Test Sentry for your Next.js app!" />
      </Head>

      <main>
        <div className="flex-spacer" />
        <svg
          height="40"
          width="40"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          role="img"
          aria-label="Sentry logo"
        >
          <path
            d="M21.85 2.995a3.698 3.698 0 0 1 1.353 1.354l16.303 28.278a3.703 3.703 0 0 1-1.354 5.053 3.694 3.694 0 0 1-1.848.496h-3.828a31.149 31.149 0 0 0 0-3.09h3.815a.61.61 0 0 0 .537-.917L20.523 5.893a.61.61 0 0 0-1.057 0l-3.739 6.494a28.948 28.948 0 0 1 9.63 10.453 28.988 28.988 0 0 1 3.499 13.78v1.542h-9.852v-1.544a19.106 19.106 0 0 0-2.182-8.85 19.08 19.08 0 0 0-6.032-6.829l-1.85 3.208a15.377 15.377 0 0 1 6.382 12.484v1.542H3.696A3.694 3.694 0 0 1 0 34.473c0-.648.17-1.286.494-1.849l2.33-4.074a8.562 8.562 0 0 1 2.689 1.536L3.158 34.17a.611.611 0 0 0 .538.917h8.448a12.481 12.481 0 0 0-6.037-9.09l-1.344-.772 4.908-8.545 1.344.77a22.16 22.16 0 0 1 7.705 7.444 22.193 22.193 0 0 1 3.316 10.193h3.699a25.892 25.892 0 0 0-3.811-12.033 25.856 25.856 0 0 0-9.046-8.796l-1.344-.772 5.269-9.136a3.698 3.698 0 0 1 3.2-1.849c.648 0 1.285.17 1.847.495Z"
            fill="currentcolor"
          />
        </svg>
        <h1>sentry-example-page</h1>

        <p className="description">
          Click the button below, and view the sample error on the Sentry{" "}
          <a
            target="_blank"
            rel="noopener"
            href="${issuesPageLink}"
          >
            Issues Page
          </a>
          . For more details about setting up Sentry,{" "}
          <a
            target="_blank"
            rel="noopener"
            href="https://docs.sentry.io/platforms/javascript/guides/nextjs/"
          >
            read our docs
          </a>
          .
        </p>

        <button
          type="button"
          onClick={async () => {${loggerUserAction}
            await Sentry.startSpan(
              {
                name: "Example Frontend/Backend Span",
                op: "test",
              },
              async () => {
                const res = await fetch("/api/sentry-example-api");
                if (!res.ok) {
                  setHasSentError(true);
                }
              },
            );
            throw new SentryExampleFrontendError(
              "This error is raised on the frontend of the example page.",
            );
          }}
          disabled={!isConnected}
        >
          <span>Throw Sample Error</span>
        </button>

        {hasSentError ? (
          <p className="success">Error sent to Sentry.</p>
        ) : !isConnected ? (
          <div className="connectivity-error">
            <p>
              It looks like network requests to Sentry are being blocked, which
              will prevent errors from being captured. Try disabling your
              ad-blocker to complete the test.
            </p>
          </div>
        ) : (
          <div className="success_placeholder" />
        )}

        <div className="flex-spacer" />
      </main>

      <style>{\`
        main {
          display: flex;
          min-height: 100vh;
          flex-direction: column;
          justify-content: center;
          align-items: center;
          gap: 16px;
          padding: 16px;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
        }

        h1 {
          padding: 0px 4px;
          border-radius: 4px;
          background-color: rgba(24, 20, 35, 0.03);
          font-family: monospace;
          font-size: 20px;
          line-height: 1.2;
        }

        p {
          margin: 0;
          font-size: 20px;
        }

        a {
          color: #6341F0;
          text-decoration: underline;
          cursor: pointer;

          @media (prefers-color-scheme: dark) {
            color: #B3A1FF;
          }
        }

        button {
          border-radius: 8px;
          color: white;
          cursor: pointer;
          background-color: #553DB8;
          border: none;
          padding: 0;
          margin-top: 4px;

          & > span {
            display: inline-block;
            padding: 12px 16px;
            border-radius: inherit;
            font-size: 20px;
            font-weight: bold;
            line-height: 1;
            background-color: #7553FF;
            border: 1px solid #553DB8;
            transform: translateY(-4px);
          }

          &:hover > span {
            transform: translateY(-8px);
          }

          &:active > span {
            transform: translateY(0);
          }

          &:disabled {
	            cursor: not-allowed;
	            opacity: 0.6;

	            & > span {
	              transform: translateY(0);
	              border: none
	            }
	          }
        }

        .description {
          text-align: center;
          color: #6E6C75;
          max-width: 500px;
          line-height: 1.5;
          font-size: 20px;

          @media (prefers-color-scheme: dark) {
            color: #A49FB5;
          }
        }

        .flex-spacer {
          flex: 1;
        }

        .success {
          padding: 12px 16px;
          border-radius: 8px;
          font-size: 20px;
          line-height: 1;
          background-color: #00F261;
          border: 1px solid #00BF4D;
          color: #181423;
        }

        .success_placeholder {
          height: 46px;
        }

        .connectivity-error {
          padding: 12px 16px;
          background-color: #E50045;
          border-radius: 8px;
          width: 500px;
          color: #FFFFFF;
          border: 1px solid #A80033;
          text-align: center;
          margin: 0;
        }

        .connectivity-error a {
          color: #FFFFFF;
          text-decoration: underline;
        }
      \`}</style>
    </div>
  );
}
`;
}

export function getSentryExamplePagesDirApiRoute({
  isTypeScript,
}: {
  isTypeScript: boolean;
}) {
  const sentryImport = `import * as Sentry from "@sentry/nextjs";

`;

  const loggerCall = `  Sentry.logger.info("Sentry example API called");
`;

  return `${sentryImport}// Custom error class for Sentry testing
class SentryExampleAPIError extends Error {
  constructor(message${isTypeScript ? ": string | undefined" : ""}) {
    super(message);
    this.name = "SentryExampleAPIError";
  }
}
// A faulty API route to test Sentry's error monitoring
export default function handler(_req, res) {
${loggerCall}throw new SentryExampleAPIError("This error is raised on the backend called by the example page.");
res.status(200).json({ name: "John Doe" });
}
`;
}

export type ExampleApiRouteDynamicStrategy = "force-dynamic" | "connection";

export function getSentryExampleAppDirApiRoute({
  isTypeScript,
  dynamicStrategy,
}: {
  isTypeScript: boolean;
  /**
   * How the route opts out of static rendering so the throwing handler runs at
   * request time instead of during the build:
   * - `force-dynamic`: `export const dynamic = "force-dynamic"`. Needed on Next.js 14,
   *   where GET route handlers are cached by default.
   * - `connection`: `await connection()` from `next/server` (Next.js 15+). Required on
   *   Next.js 16 with `cacheComponents`, which rejects route segment config.
   */
  dynamicStrategy: ExampleApiRouteDynamicStrategy;
}) {
  const useConnection = dynamicStrategy === "connection";

  const sentryImport = `import * as Sentry from "@sentry/nextjs";
${useConnection ? 'import { connection } from "next/server";\n' : ""}`;

  const forceDynamicExport = useConnection
    ? ""
    : `export const dynamic = "force-dynamic";

`;

  const connectionCall = useConnection
    ? `
  // Opt out of prerendering so the error is thrown at request time
  await connection();`
    : "";

  const loggerCall = `
  Sentry.logger.info("Sentry example API called");`;

  // Note: We intentionally don't have a return statement after throw - it would be unreachable code
  // We also don't import NextResponse since we don't use it (Biome noUnusedImports rule)
  return `${sentryImport}${forceDynamicExport}class SentryExampleAPIError extends Error {
  constructor(message${isTypeScript ? ": string | undefined" : ""}) {
    super(message);
    this.name = "SentryExampleAPIError";
  }
}

// A faulty API route to test Sentry's error monitoring
export ${
    useConnection ? "async " : ""
  }function GET() {${connectionCall}${loggerCall}
  throw new SentryExampleAPIError(
    "This error is raised on the backend called by the example page.",
  );
}
`;
}

export function getSentryDefaultUnderscoreErrorPage() {
  return `import * as Sentry from "@sentry/nextjs";
import Error from "next/error";

const CustomErrorComponent = (props) => {
  return <Error statusCode={props.statusCode} />;
};

CustomErrorComponent.getInitialProps = async (contextData) => {
  // In case this is running in a serverless function, await this in order to give Sentry
  // time to send the error before the lambda exits
  await Sentry.captureUnderscoreErrorException(contextData);

  // This will contain the status code of the response
  return Error.getInitialProps(contextData);
};

export default CustomErrorComponent;
`;
}

export function getSimpleUnderscoreErrorCopyPasteSnippet() {
  return `
${chalk.green(`import * as Sentry from '@sentry/nextjs';`)}
${chalk.green(`import Error from "next/error";`)}

${chalk.dim(
  '// Replace "YourCustomErrorComponent" with your custom error component!',
)}
YourCustomErrorComponent.getInitialProps = async (${chalk.green(
    "contextData",
  )}) => {
  ${chalk.green("await Sentry.captureUnderscoreErrorException(contextData);")}

  ${chalk.dim("// ...other getInitialProps code")}

  return Error.getInitialProps(contextData);
};
`;
}

export function getGenerateMetadataSnippet(isTs: boolean) {
  return makeCodeSnippet(true, (unchanged, plus) => {
    return plus(`
      import * as Sentry from '@sentry/nextjs';
      ${isTs ? `import type { Metadata } from 'next';` : ""}

      ${unchanged(
        '// Add or edit your "generateMetadata" to include the Sentry trace data:',
      )}
      export function generateMetadata()${isTs ? ": Metadata" : ""} {
        return {
          // ... your existing metadata
          other: {
            ...Sentry.getTraceData()
          }
        };
      }
`);
  });
}

export function getFullUnderscoreErrorCopyPasteSnippet(isTs: boolean) {
  return `
import * as Sentry from '@sentry/nextjs';${
    isTs ? '\nimport type { NextPageContext } from "next";' : ""
  }
import Error from "next/error";

${chalk.dim(
  '// Replace "YourCustomErrorComponent" with your custom error component!',
)}
YourCustomErrorComponent.getInitialProps = async (contextData${
    isTs ? ": NextPageContext" : ""
  }) => {
  await Sentry.captureUnderscoreErrorException(contextData);

  return Error.getInitialProps(contextData);
};
`;
}

export function getInstrumentationHookContent(
  instrumentationHookLocation: "src" | "root",
) {
  return `import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("${
      instrumentationHookLocation === "root" ? "." : ".."
    }/sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("${
      instrumentationHookLocation === "root" ? "." : ".."
    }/sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
`;
}

export function getInstrumentationHookCopyPasteSnippet(
  instrumentationHookLocation: "src" | "root",
) {
  return makeCodeSnippet(true, (unchanged, plus) => {
    return unchanged(`${plus("import * as Sentry from '@sentry/nextjs';")}

export ${plus("async")} function register() {
  ${plus(`if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('${
      instrumentationHookLocation === "root" ? "." : ".."
    }/sentry.server.config');
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    await import('${
      instrumentationHookLocation === "root" ? "." : ".."
    }/sentry.edge.config');
  }`)}
}

${plus("export const onRequestError = Sentry.captureRequestError;")}
`);
  });
}

export function getInstrumentationClientHookCopyPasteSnippet(
  dsn: string,
  selectedFeaturesMap: {
    replay: boolean;
    performance: boolean;
  },
  reduceDataCollection: boolean,
  spotlight = false,
) {
  return makeCodeSnippet(true, (_unchanged, plus) => {
    return plus(
      getInstrumentationClientFileContents(
        dsn,
        selectedFeaturesMap,
        reduceDataCollection,
        spotlight,
      ),
    );
  });
}

export function getSentryDefaultGlobalErrorPage(isTs: boolean) {
  return isTs
    ? `"use client";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        {/* \`NextError\` is the default Next.js error page component. Its type
        definition requires a \`statusCode\` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
`
    : `"use client";

import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

export default function GlobalError({ error }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en">
      <body>
        {/* \`NextError\` is the default Next.js error page component. Its type
        definition requires a \`statusCode\` prop. However, since the App Router
        does not expose status codes for errors, we simply pass 0 to render a
        generic error message. */}
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
`;
}

export function getGlobalErrorCopyPasteSnippet(isTs: boolean) {
  if (isTs) {
    return `"use client";

${chalk.green('import * as Sentry from "@sentry/nextjs";')}
${chalk.green('import Error from "next/error";')}
${chalk.green('import { useEffect } from "react";')}

export default function GlobalError(${chalk.green(
      "{ error }: { error: Error }",
    )}) {
  ${chalk.green(`useEffect(() => {
    Sentry.captureException(error);
  }, [error]);`)}

  return (
    <html>
      <body>
        {/* Your Error component here... */}
      </body>
    </html>
  );
}
`;
  }
  return `"use client";

${chalk.green('import * as Sentry from "@sentry/nextjs";')}
${chalk.green('import Error from "next/error";')}
${chalk.green('import { useEffect } from "react";')}

export default function GlobalError(${chalk.green("{ error }")}) {
  ${chalk.green(`useEffect(() => {
    Sentry.captureException(error);
  }, [error]);`)}

  return (
    <html>
      <body>
        {/* Your Error component here... */}
      </body>
    </html>
  );
}
`;
}

export const getRootLayout = (
  isTs: boolean,
) => `// This file was generated by the Sentry wizard because we couldn't find a root layout file.
// You can delete this file at any time.

export const metadata = {
  title: 'Sentry NextJS Example',
  description: 'Generated by Sentry',
}

export default function RootLayout({
  children,
}${
  isTs
    ? `: {
  children: React.ReactNode
}`
    : ""
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`;

export const getRootLayoutWithGenerateMetadata = (
  isTs: boolean,
) => `// This file was generated by the Sentry wizard because we couldn't find a root layout file.
import * as Sentry from '@sentry/nextjs';
${isTs ? `import type { Metadata } from 'next';` : ""}

export function generateMetadata()${isTs ? ": Metadata" : ""} {
  return {
    other: {
      ...Sentry.getTraceData(),
    }
  }
};

export default function RootLayout({
  children,
}${
  isTs
    ? `: {
  children: React.ReactNode
}`
    : ""
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
`;
