/**
 * Code and config snippets the Flutter wizard writes or shows.
 */

import { makeCodeSnippet } from "../utils/clack/index.js";

export const sentryImport = `import 'package:sentry_flutter/sentry_flutter.dart';\n`;
export const sessionReplaySampleRate = 0.1;
export const sessionReplayOnErrorSampleRate = 1.0;

export function pubspecOptions(project: string, org: string): string {
  return `sentry:
  upload_debug_symbols: true
  upload_source_maps: true
  project: ${project}
  org: ${org}
`;
}

export function sentryProperties(authToken: string): string {
  return `auth_token=${authToken}`;
}

export function initSnippet(
  dsn: string,
  selectedFeaturesMap: {
    tracing: boolean;
    replay: boolean;
  },
  runApp: string,
): string {
  let snippet = `await SentryFlutter.init(
    (options) {
      options.dsn = '${dsn}';
      // Adds request headers and IP for users, for more info visit:
      // https://docs.sentry.io/platforms/dart/guides/flutter/data-management/data-collected/
      options.sendDefaultPii = true;`;

  if (selectedFeaturesMap.tracing) {
    snippet += `
      // Set tracesSampleRate to 1.0 to capture 100% of transactions for tracing.
      // We recommend adjusting this value in production.
      options.tracesSampleRate = 1.0;`;
  }

  if (selectedFeaturesMap.replay) {
    snippet += `
      // Configure Session Replay
      options.replay.sessionSampleRate = ${
        sessionReplaySampleRate % 1 === 0
          ? `${sessionReplaySampleRate}.0`
          : sessionReplaySampleRate
      };
      options.replay.onErrorSampleRate = ${
        sessionReplayOnErrorSampleRate % 1 === 0
          ? `${sessionReplayOnErrorSampleRate}.0`
          : sessionReplayOnErrorSampleRate
      };`;
  }

  snippet += `
    },
    appRunner: () => runApp(SentryWidget(child: ${runApp})),
  );
  // TODO: Remove this line after sending the first sample event to sentry.
  await Sentry.captureException(StateError('This is a sample exception.'));`;

  return snippet;
}

export function pubspecSnippetColored(
  sentryVersion: string,
  pluginVersion: string,
  project: string,
  org: string,
): string {
  const snippet = `dependencies:
  sentry_flutter: ${sentryVersion}

dev_dependencies:
  sentry_dart_plugin: ${pluginVersion}
  
${pubspecOptions(project, org)}`;

  return makeCodeSnippet(true, (_unchanged, plus, _minus) => {
    return plus(snippet);
  });
}

export function initSnippetColored(dsn: string): string {
  const snippet = `import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  await SentryFlutter.init(
    (options) {
      options.dsn = '${dsn}';
      // Adds request headers and IP for users, for more info visit:
      // https://docs.sentry.io/platforms/dart/guides/flutter/data-management/data-collected/
      options.sendDefaultPii = true;
      
      // Set tracesSampleRate to 1.0 to capture 100% of transactions for tracing.
      // We recommend adjusting this value in production.
      options.tracesSampleRate = 1.0;
    },
    appRunner: () => runApp(SentryWidget(child: YourApp())),
  );
}`;
  return makeCodeSnippet(true, (_unchanged, plus, _minus) => {
    return plus(snippet);
  });
}
