import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FeatureId =
  | "errors"
  | "tracing"
  | "logs"
  | "replay"
  | "metrics"
  | "sourcemaps"
  | "profiling";

/** Feature IDs that are valid for the wizard `--features` flag. */
export const WIZARD_FEATURE_IDS: Set<string> = new Set<FeatureId>([
  "errors",
  "tracing",
  "logs",
  "replay",
  "metrics",
  "sourcemaps",
  "profiling",
]);

export type FeatureDoc = {
  feature: string;
  docsUrls: string[];
};

export type Platform = {
  id: string;
  name: string;
  templateDir: string;
  sdkPackage: string;
  depFile: string;
  docs: FeatureDoc[];
  buildCmd?: string;
  installCmd: string;
  initPattern: RegExp;
  timeout: number;
};

const TEMPLATES_DIR = join(import.meta.dirname, "../templates");

/** Load feature docs from the external JSON config. */
const featureDocsRaw: Record<string, Record<string, string[]>> = JSON.parse(
  readFileSync(join(import.meta.dirname, "../feature-docs.json"), "utf-8")
);

function getDocs(platformId: string): FeatureDoc[] {
  const entry = featureDocsRaw[platformId];
  if (!entry) {
    throw new Error(
      `No feature docs found for platform "${platformId}" in feature-docs.json`
    );
  }
  return Object.entries(entry).map(([feature, urls]) => ({
    feature,
    docsUrls: urls,
  }));
}

export const PLATFORMS: Platform[] = [
  {
    id: "nextjs",
    name: "Next.js",
    templateDir: join(TEMPLATES_DIR, "nextjs-app"),
    sdkPackage: "@sentry/nextjs",
    depFile: "package.json",
    docs: getDocs("nextjs"),
    installCmd: "npm install",
    buildCmd: "npm run build",
    initPattern: /Sentry\.init/,
    timeout: 300_000,
  },
  {
    id: "express",
    name: "Express",
    templateDir: join(TEMPLATES_DIR, "express-app"),
    sdkPackage: "@sentry/node",
    depFile: "package.json",
    docs: getDocs("express"),
    installCmd: "npm install",
    buildCmd: "npx tsc --noEmit",
    initPattern: /Sentry\.init/,
    timeout: 300_000,
  },
  {
    id: "python-flask",
    name: "Flask",
    templateDir: join(TEMPLATES_DIR, "python-flask-app"),
    sdkPackage: "sentry-sdk",
    depFile: "requirements.txt",
    docs: getDocs("python-flask"),
    installCmd:
      "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
    buildCmd: ".venv/bin/python -m compileall -q .",
    initPattern: /sentry_sdk\.init/,
    timeout: 300_000,
  },
  {
    id: "python-fastapi",
    name: "FastAPI",
    templateDir: join(TEMPLATES_DIR, "python-fastapi-app"),
    sdkPackage: "sentry-sdk",
    depFile: "requirements.txt",
    docs: getDocs("python-fastapi"),
    installCmd:
      "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
    buildCmd: ".venv/bin/python -m compileall -q .",
    initPattern: /sentry_sdk\.init/,
    timeout: 300_000,
  },
  {
    id: "sveltekit",
    name: "SvelteKit",
    templateDir: join(TEMPLATES_DIR, "sveltekit-app"),
    sdkPackage: "@sentry/sveltekit",
    depFile: "package.json",
    docs: getDocs("sveltekit"),
    installCmd: "npm install",
    buildCmd: "npm run build",
    initPattern: /Sentry\.init/,
    timeout: 300_000,
  },
  {
    id: "react-vite",
    name: "React + Vite",
    templateDir: join(TEMPLATES_DIR, "react-vite-app"),
    sdkPackage: "@sentry/react",
    depFile: "package.json",
    docs: getDocs("react-vite"),
    installCmd: "npm install",
    buildCmd: "npm run build",
    initPattern: /Sentry\.init/,
    timeout: 300_000,
  },
];

export function getPlatform(id: string): Platform {
  const p = PLATFORMS.find((entry) => entry.id === id);
  if (!p) throw new Error(`Unknown platform: ${id}`);
  return p;
}
