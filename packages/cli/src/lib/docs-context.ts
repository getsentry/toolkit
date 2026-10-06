import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

export type DocsProjectContext = {
  frameworks: string[];
  languages: string[];
  sentryConfigured: boolean;
};

/** The complete allowlist for automatic local docs context. */
export const DOCS_CONTEXT_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Gemfile",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "pubspec.yaml",
  "mix.exs",
  "composer.json",
] as const;

const DOCS_CONTEXT_CONFIGS = [
  "sentry.client.config.ts",
  "sentry.client.config.js",
  "sentry.server.config.ts",
  "sentry.server.config.js",
  "sentry.edge.config.ts",
  "sentry.edge.config.js",
  "sentry.properties",
] as const;

const FRAMEWORK_SIGNALS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bnext(?:\.js)?\b/i, "nextjs"],
  [/@remix-run/i, "remix"],
  [/@sveltejs/i, "sveltekit"],
  [/@angular/i, "angular"],
  [/\bnestjs\b/i, "nestjs"],
  [/\bfastapi\b/i, "fastapi"],
  [/\bdjango\b/i, "django"],
  [/\bflask\b/i, "flask"],
  [/\brails\b/i, "rails"],
  [/\blaravel\b/i, "laravel"],
  [/\bflutter\b/i, "flutter"],
];

export type DocsContextReader = {
  hasConfig: (name: (typeof DOCS_CONTEXT_CONFIGS)[number]) => Promise<boolean>;
  readManifest: (
    name: (typeof DOCS_CONTEXT_MANIFESTS)[number]
  ) => Promise<string | undefined>;
};

function addFrameworkSignals(text: string, frameworks: Set<string>): void {
  for (const [signal, framework] of FRAMEWORK_SIGNALS) {
    if (signal.test(text)) {
      frameworks.add(framework);
    }
  }
}

function addLanguageSignal(
  manifest: (typeof DOCS_CONTEXT_MANIFESTS)[number],
  languages: Set<string>
): void {
  const languageByManifest: Partial<
    Record<(typeof DOCS_CONTEXT_MANIFESTS)[number], string>
  > = {
    "package.json": "javascript",
    "pyproject.toml": "python",
    "requirements.txt": "python",
    Gemfile: "ruby",
    "go.mod": "go",
    "Cargo.toml": "rust",
    "pom.xml": "java",
    "build.gradle": "android",
    "build.gradle.kts": "android",
    "pubspec.yaml": "dart",
    "mix.exs": "elixir",
    "composer.json": "php",
  };
  const language = languageByManifest[manifest];
  if (language) {
    languages.add(language);
  }
}

function containsSentrySdk(text: string): boolean {
  const normalized = text.toLowerCase();
  return normalized.includes("@sentry/") || normalized.includes("sentry-sdk");
}

/**
 * Extract normalized hints from the fixed allowlist. Returned data never
 * contains manifest/config contents, paths, DSNs, tokens, or package lists.
 */
export async function detectDocsContextFromReader(
  reader: DocsContextReader
): Promise<DocsProjectContext> {
  const frameworks = new Set<string>();
  const languages = new Set<string>();
  let sentryConfigured = false;

  for (const manifest of DOCS_CONTEXT_MANIFESTS) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const contents = await reader.readManifest(manifest);
      if (contents === undefined) {
        continue;
      }
      addLanguageSignal(manifest, languages);
      addFrameworkSignals(contents, frameworks);
      sentryConfigured ||= containsSentrySdk(contents);
    } catch {
      // Missing/unreadable metadata is optional and must not block lookup.
    }
  }

  for (const config of DOCS_CONTEXT_CONFIGS) {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      sentryConfigured ||= await reader.hasConfig(config);
    } catch {
      // Config presence is an optional signal only.
    }
  }

  return {
    frameworks: [...frameworks].sort(),
    languages: [...languages].sort(),
    sentryConfigured,
  };
}

/** Detect safe docs metadata directly below the command's working directory. */
export function detectDocsContext(cwd: string): Promise<DocsProjectContext> {
  return detectDocsContextFromReader({
    async readManifest(name) {
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        return await readFile(join(cwd, name), "utf8");
      } catch {
        return;
      }
    },
    async hasConfig(name) {
      // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
      try {
        await access(join(cwd, name));
        return true;
      } catch {
        return false;
      }
    },
  });
}
