/**
 * Writes the example page that throws a test error in a Remix app.
 */

import { existsSync, mkdirSync, promises } from "node:fs";
import path from "node:path";
import { clack } from "../utils/clack/prompts.js";

/**
 * Creates an example Remix page to test Sentry
 */
export async function createExamplePage(options: {
  selfHosted: boolean;
  orgSlug: string;
  projectId: string;
  url: string;
  isTS: boolean;
}) {
  const routesPath = "app/routes";

  if (!existsSync(routesPath)) {
    mkdirSync(routesPath, { recursive: true });
  }

  const exampleRoutePath = `app/routes/sentry-example-page.${
    options.isTS ? "ts" : "js"
  }x`;

  if (existsSync(exampleRoutePath)) {
    clack.log.warn(
      `It seems like a sentry example page already exists (${path.basename(
        exampleRoutePath,
      )}). Skipping creation of example route.`,
    );
  } else {
    await promises.writeFile(
      exampleRoutePath,
      getSentryExamplePageContents(options),
    );
    clack.log.info(`Created sentry example page at ${exampleRoutePath}.`);
  }

  // The page's button fetches this route to raise a backend error.
  const exampleApiPath = `${routesPath}/api.sentry-example-api.${
    options.isTS ? "ts" : "js"
  }`;
  if (!existsSync(exampleApiPath)) {
    await promises.writeFile(
      exampleApiPath,
      getSentryExampleApiContents(options),
    );
    clack.log.info(`Created sentry example API route at ${exampleApiPath}.`);
  }
}

export function getSentryExampleApiContents(options: { isTS?: boolean }) {
  return `import * as Sentry from "@sentry/remix";

class SentryExampleBackendError extends Error {
  constructor(message${options.isTS ? ": string | undefined" : ""}) {
    super(message);
    this.name = "SentryExampleBackendError";
  }
}

export async function loader() {
  await Sentry.startSpan({
    name: 'Example Backend Span',
    op: 'test'
  }, async () => {
    // Simulate some backend work
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  throw new SentryExampleBackendError("This error is raised on the backend of the example page.");
}
`;
}

export function getSentryExamplePageContents(options: {
  selfHosted: boolean;
  orgSlug: string;
  projectId: string;
  url: string;
  isTS?: boolean;
}) {
  const issuesPageLink = options.selfHosted
    ? `${options.url}organizations/${options.orgSlug}/issues/?project=${options.projectId}`
    : `https://${options.orgSlug}.sentry.io/issues/?project=${options.projectId}`;

  return `import * as Sentry from "@sentry/remix";
import { useState, useEffect } from "react";

class SentryExampleFrontendError extends Error {
  constructor(message${options.isTS ? ": string | undefined" : ""}) {
    super(message);
    this.name = "SentryExampleFrontendError";
  }
}

export const meta = () => {
  return [
    { title: "sentry-example-page" },
  ];
}

export default function SentryExamplePage() {
  const [hasSentError, setHasSentError] = useState(false);
  const [isConnected, setIsConnected] = useState(true);
  
  useEffect(() => {
    async function checkConnectivity() {
      const result = await Sentry.diagnoseSdkConnectivity();
      setIsConnected(result !== 'sentry-unreachable');
    }
    checkConnectivity();
  }, [setIsConnected]);

  return (
    <div>
      <main>
        <div className="flex-spacer" />
        <svg height="40" width="40" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M21.85 2.995a3.698 3.698 0 0 1 1.353 1.354l16.303 28.278a3.703 3.703 0 0 1-1.354 5.053 3.694 3.694 0 0 1-1.848.496h-3.828a31.149 31.149 0 0 0 0-3.09h3.815a.61.61 0 0 0 .537-.917L20.523 5.893a.61.61 0 0 0-1.057 0l-3.739 6.494a28.948 28.948 0 0 1 9.63 10.453 28.988 28.988 0 0 1 3.499 13.78v1.542h-9.852v-1.544a19.106 19.106 0 0 0-2.182-8.85 19.08 19.08 0 0 0-6.032-6.829l-1.85 3.208a15.377 15.377 0 0 1 6.382 12.484v1.542H3.696A3.694 3.694 0 0 1 0 34.473c0-.648.17-1.286.494-1.849l2.33-4.074a8.562 8.562 0 0 1 2.689 1.536L3.158 34.17a.611.611 0 0 0 .538.917h8.448a12.481 12.481 0 0 0-6.037-9.09l-1.344-.772 4.908-8.545 1.344.77a22.16 22.16 0 0 1 7.705 7.444 22.193 22.193 0 0 1 3.316 10.193h3.699a25.892 25.892 0 0 0-3.811-12.033 25.856 25.856 0 0 0-9.046-8.796l-1.344-.772 5.269-9.136a3.698 3.698 0 0 1 3.2-1.849c.648 0 1.285.17 1.847.495Z" fill="currentcolor"/>
        </svg>
        <h1>
          sentry-example-page
        </h1>

        <p className="description">
          Click the button below, and view the sample error on the Sentry <a target="_blank" rel="noreferrer" href="${issuesPageLink}">Issues Page</a>. 
          For more details about setting up Sentry, <a target="_blank" rel="noreferrer" href="https://docs.sentry.io/platforms/javascript/guides/remix/">read our docs</a>.
        </p>

        <button
          type="button"
          onClick={async () => {
            await Sentry.startSpan({
              name: 'Example Frontend Span',
              op: 'test'
            }, async () => {
              const res = await fetch("/api/sentry-example-api");
              if (!res.ok) {
                setHasSentError(true);
              }
            });
            throw new SentryExampleFrontendError("This error is raised on the frontend of the example page.");
          }}
          disabled={!isConnected}
        >
          <span>
            Throw Sample Error
          </span>
        </button>

        {hasSentError ? (
          <p className="success">
            Sample error was sent to Sentry.
          </p>
        ) : !isConnected ? (
          <div className="connectivity-error">
            <p>It looks like network requests to Sentry are being blocked, which will prevent errors from being captured. Try disabling your ad-blocker to complete the test.</p>
          </div>
        ) : (
          <div className="success_placeholder" />
        )}

        <div className="flex-spacer" />
      </main>

      {/* Not for production use! We're just saving you from having to delete an extra CSS file ;) */}
      <style dangerouslySetInnerHTML={{ __html: styles }}></style>
    </div>
  );
}

const styles = \`
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
        border: none;
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
\`;
`;
}
