/**
 * Create an example Angular component that throws a test error, and show
 * how to add it to a page.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import chalk from "chalk";
import {
  abortIfCancelled,
  makeCodeSnippet,
  showCopyPasteInstructions,
} from "../utils/clack/index.js";
import { clack } from "../utils/clack/prompts.js";
import { buildProjectIssuesUrl } from "../../sentry-web-urls.js";

interface ExampleComponentOptions {
  orgSlug: string;
  projectId: string;
}

/** Write `sentry-example.component.ts` and show how to use it. */
export async function createExampleComponent(
  options: ExampleComponentOptions,
): Promise<void> {
  const componentName = "sentry-example";
  const appRootPath = "./src/app";

  let componentDirPath = appRootPath;
  const hasAppRoot = existsSync(appRootPath);
  if (!hasAppRoot) {
    componentDirPath = await abortIfCancelled(
      clack.text({
        message: "Where should we create the example component?",
        placeholder: appRootPath,
        validate(value) {
          if (!value) {
            return "Please enter a path.";
          }
          return undefined;
        },
      }),
    );
  }

  if (!existsSync(componentDirPath)) {
    mkdirSync(componentDirPath, { recursive: true });
  }

  const componentCode = getSentryExampleComponentCode(options);

  const componentFilePath = `${componentDirPath}/${componentName}.component.ts`;

  writeFileSync(componentFilePath, componentCode);

  clack.log.success(
    `Created example component at ${chalk.cyan(componentFilePath)}`,
  );

  const addComponentCodeSnippet = makeCodeSnippet(true, (unchanged, plus) =>
    unchanged(`${plus(
      "import { SentryExample } from './sentry-example.component'",
    )}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ${plus("SentryExample")}],
  template: \`
    <div class="app">
      <h1>Your Application</h1>
      ${plus("<app-sentry-example></app-sentry-example>")}
    </div>
  \`,
})
`),
  );

  await showCopyPasteInstructions({
    instructions: `Add the example component one of your pages or components (for example, in ${chalk.cyan(
      "app.component.ts",
    )}).`,
    codeSnippet: addComponentCodeSnippet,
  });
}

/** The source of the example component. */
export function getSentryExampleComponentCode(
  options: ExampleComponentOptions,
): string {
  const issueStreamUrl = buildProjectIssuesUrl(
    options.orgSlug,
    options.projectId,
  );

  return `import { NgIf } from '@angular/common';
import { Component, OnInit } from '@angular/core';
import * as Sentry from '@sentry/angular';

/**
 * This is just a very simple component that throws an example error.
 * Feel free to delete this file once you verify that Sentry is working.
 */

@Component({
  selector: 'app-sentry-example',
  standalone: true,
  imports: [NgIf],
  template: \`
    <svg height="40" width="40" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M21.85 2.995a3.698 3.698 0 0 1 1.353 1.354l16.303 28.278a3.703 3.703 0 0 1-1.354 5.053 3.694 3.694 0 0 1-1.848.496h-3.828a31.149 31.149 0 0 0 0-3.09h3.815a.61.61 0 0 0 .537-.917L20.523 5.893a.61.61 0 0 0-1.057 0l-3.739 6.494a28.948 28.948 0 0 1 9.63 10.453 28.988 28.988 0 0 1 3.499 13.78v1.542h-9.852v-1.544a19.106 19.106 0 0 0-2.182-8.85 19.08 19.08 0 0 0-6.032-6.829l-1.85 3.208a15.377 15.377 0 0 1 6.382 12.484v1.542H3.696A3.694 3.694 0 0 1 0 34.473c0-.648.17-1.286.494-1.849l2.33-4.074a8.562 8.562 0 0 1 2.689 1.536L3.158 34.17a.611.611 0 0 0 .538.917h8.448a12.481 12.481 0 0 0-6.037-9.09l-1.344-.772 4.908-8.545 1.344.77a22.16 22.16 0 0 1 7.705 7.444 22.193 22.193 0 0 1 3.316 10.193h3.699a25.892 25.892 0 0 0-3.811-12.033 25.856 25.856 0 0 0-9.046-8.796l-1.344-.772 5.269-9.136a3.698 3.698 0 0 1 3.2-1.849c.648 0 1.285.17 1.847.495Z"
        fill="currentcolor"
      />
    </svg>

    <h1>app-sentry-example</h1>

    <p class="description">
      Click the button below, and view the sample error on the Sentry
      <a
        target="_blank"
        href="${issueStreamUrl}"
        >Issues Page</a
      >. For more details about setting up Sentry,
      <a
        target="_blank"
        href="https://docs.sentry.io/platforms/javascript/guides/angular/"
        >read our docs</a
      >.
    </p>

    <button (click)="throwError()">
      <span>Throw Sample Error</span>
    </button>

    <div *ngIf="isConnected && sentError" class="success">
      Sample error was sent to Sentry.
    </div>
    <div *ngIf="isConnected && !sentError" class="success_placeholder"></div>

    <div *ngIf="!isConnected" class="connectivity-error">
      <p>
        The Sentry SDK is not able to reach Sentry right now - this may be due
        to an adblocker. For more information, see
        <a
          target="_blank"
          href="https://docs.sentry.io/platforms/javascript/guides/angular/troubleshooting/#the-sdk-is-not-sending-any-data"
          >the troubleshooting guide</a
        >.
      </p>
    </div>

    <p class="description">
      Adblockers will prevent errors from being sent to Sentry.
    </p>
  \`,
  styles: \`
    :host {
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      align-items: center;
      border: 2px solid #553DB8;
      border-radius: 8px;
      padding: 1em;
      margin: 0.5em;
      width: 500px;
      height: 495px;
      gap: 1em;
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

    .connectivity-error {
      padding: 12px 16px;
      background-color: #E50045;
      border-radius: 8px;
      width: 500px;
      color: #FFFFFF;
      border: 1px solid #A80033;
      text-align: center;
      margin: 0;
      max-width: 400px;
    }
  
    .connectivity-error a {
      color: #FFFFFF;
      text-decoration: underline;
    }
  \`,
})
export class SentryExample implements OnInit {
  sentError = false;
  isConnected = true;

  async ngOnInit(): Promise<void> {
    const res = await Sentry.diagnoseSdkConnectivity();
    this.isConnected = res !== 'sentry-unreachable';
  }

  throwError() {
    Sentry.startSpan(
      {
        name: 'Example Frontend Span',
        op: 'test',
      },
      () => {
        this.sentError = true;
        throw new SentryExampleError(
          'This error was thrown by the Sentry example component.'
        );
      }
    );
  }
}

class SentryExampleError extends Error {
  constructor(message: string | undefined) {
    super(message);
    this.name = 'SentryExampleError';
  }
}
`;
}
