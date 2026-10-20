#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.cwd());
const docsDir = join(root, "docs");

/** Recursively collect docs files */
function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const e of entries) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) files.push(...walk(p));
    else if (e.endsWith(".md") || e.endsWith(".mdc")) files.push(p);
  }
  return files;
}

const files = walk(docsDir);

const problems = [];

for (const file of files) {
  const rel = file.slice(root.length + 1);
  const content = readFileSync(file, "utf8");

  // Strip fenced code blocks to avoid false positives in examples
  const contentNoFences = content.replace(/```[\s\S]*?```/g, "");

  // 1) Validate local Markdown links like [text](./file.md) or [text](../file.mdc).
  // Local docs should use Markdown links so humans can navigate them and agents do
  // not inline entire files through at-prefixed references.
  const localLinkRe = /!?\[[^\]]+\]\((?!https?:|mailto:|#)([^)]+)\)/g;
  for (const m of contentNoFences.matchAll(localLinkRe)) {
    // Skip illustrative placeholders
    if (m[1].includes("...")) continue;
    const target = m[1].split("#")[0].replace(/^<|>$/g, "");
    if (!target) continue;
    const abs = resolve(file, "..", target);
    try {
      const st = statSync(abs);
      if (!st.isFile()) {
        problems.push({
          file: rel,
          type: "missing-link-target",
          message: `${m[0]} does not point to a file`,
        });
      }
    } catch {
      problems.push({
        file: rel,
        type: "missing-link-target",
        message: `${m[0]} points to missing file ${target}`,
      });
    }
  }

  // 1b) Flag Markdown links that point to at-prefixed repo paths.
  const atMarkdownLinkRe =
    /\[[^\]]+\]\(@(?:docs|packages|scripts|AGENTS\.md|README\.md|TELEMETRY\.md)[^)]+\)/g;
  for (const m of contentNoFences.matchAll(atMarkdownLinkRe)) {
    problems.push({
      file: rel,
      type: "atpath-markdown-link",
      message: `Use Markdown links or plain relative paths instead of at-prefixed repo paths: ${m[0]}`,
    });
  }

  // 2) Flag at-prefixed repo-local references. These can force some agents to
  // inline the entire target file.
  const atPathRe =
    /@(?:docs|packages|scripts)\/[A-Za-z0-9_.\-/]+\.(?:mdc|md|ts|tsx|js|json)|@(?:AGENTS|README|TELEMETRY)\.md/g;
  for (const m of contentNoFences.matchAll(atPathRe)) {
    problems.push({
      file: rel,
      type: "atpath-reference",
      message: `Use Markdown links for docs or plain relative paths for code: ${m[0]}`,
    });
  }
}

if (problems.length) {
  console.error("[docs:check] Problems found:\n");
  for (const p of problems) {
    console.error(`- ${p.type}: ${p.file} -> ${p.message}`);
  }
  process.exit(1);
} else {
  console.log(
    "[docs:check] OK: local Markdown links resolve and no at-prefixed repo paths found.",
  );
}
