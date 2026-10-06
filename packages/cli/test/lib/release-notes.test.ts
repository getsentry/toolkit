/**
 * Unit Tests for Release Notes Parser & Aggregation
 *
 * Tests core invariants (section extraction, version filtering, truncation)
 * that are hard to express as property-based tests due to format specifics.
 *
 * Core random-input invariants (category validity, filtering, commit parsing)
 * are tested via property-based tests in release-notes.property.test.ts.
 */

import { marked } from "marked";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { UPGRADE_SOURCES } from "../../src/lib/binary.js";
import {
  fetchRecentReleases,
  type GitHubRelease,
} from "../../src/lib/delta-upgrade.js";
import {
  buildChangelogSummary,
  type ChangeCategory,
  countListItems,
  extractNightlyTimestamp,
  extractSections,
  fetchChangelog,
  parseCommitMessages,
} from "../../src/lib/release-notes.js";
import { mockFetch } from "../helpers.js";

// ─────────────────────────── Fixtures ──────────────────────────────────────

/** Realistic release body from 0.21.0 (simplified) */
const SAMPLE_RELEASE_BODY = `### New Features ✨

#### Dashboard

- Add pagination and glob filtering to dashboard list by @BYK in [#560](https://github.com/getsentry/cli/pull/560)
- Add a full chart rendering engine by @BYK in [#555](https://github.com/getsentry/cli/pull/555)

#### Other

- Bidirectional cursor pagination by @BYK in [#564](https://github.com/getsentry/cli/pull/564)
- Add \`sentry sourcemap inject\` and upload commands by @BYK in [#547](https://github.com/getsentry/cli/pull/547)

### Bug Fixes 🐛

#### Dashboard

- Fix table widget rendering by @BYK in [#584](https://github.com/getsentry/cli/pull/584)

#### Other

- Show meaningful message for network errors by @BYK in [#572](https://github.com/getsentry/cli/pull/572)

### Documentation 📚

- Add missing command pages by @sergical in [#569](https://github.com/getsentry/cli/pull/569)

### Internal Changes 🔧

- Use informational-patch input instead of sed hack by @BYK in [#544](https://github.com/getsentry/cli/pull/544)
- Bump Bun from 1.3.9 to 1.3.11 by @BYK in [#552](https://github.com/getsentry/cli/pull/552)`;

function makeRelease(tagName: string, body?: string): GitHubRelease {
  return { tag_name: tagName, assets: [], body };
}

// ─────────────────────── extractSections ────────────────────────────────────

describe("extractSections", () => {
  test("extracts features and fixes, filters docs and internal", () => {
    const sections = extractSections(SAMPLE_RELEASE_BODY);
    const categories = sections.map((s) => s.category);

    expect(categories).toContain("features");
    expect(categories).toContain("fixes");
    expect(categories).not.toContain("docs" as ChangeCategory);
    expect(categories).not.toContain("internal" as ChangeCategory);
  });

  test("features section contains correct entries", () => {
    const sections = extractSections(SAMPLE_RELEASE_BODY);
    const features = sections.find((s) => s.category === "features");
    expect(features).toBeDefined();
    expect(features!.markdown).toContain("pagination");
    expect(features!.markdown).toContain("sourcemap");
  });

  test("preserves subheadings (#### scope groups)", () => {
    const sections = extractSections(SAMPLE_RELEASE_BODY);
    const features = sections.find((s) => s.category === "features");
    expect(features!.markdown).toContain("#### Dashboard");
    expect(features!.markdown).toContain("#### Other");
  });

  test("empty body returns empty array", () => {
    expect(extractSections("")).toEqual([]);
    expect(extractSections("  \n  ")).toEqual([]);
  });

  test("body with no matching sections returns empty array", () => {
    const body =
      "### Documentation 📚\n\n- Some doc change\n\n### Internal Changes 🔧\n\n- Some internal change";
    expect(extractSections(body)).toEqual([]);
  });

  test("handles performance section", () => {
    const body =
      "### Performance\n\n- Optimize query execution\n- Reduce memory usage";
    const sections = extractSections(body);
    expect(sections).toHaveLength(1);
    expect(sections[0]!.category).toBe("performance");
  });
});

// ──────────────────── buildChangelogSummary ─────────────────────────────────

describe("buildChangelogSummary", () => {
  const releases: GitHubRelease[] = [
    makeRelease("0.21.0", SAMPLE_RELEASE_BODY),
    makeRelease(
      "0.20.0",
      "### New Features ✨\n\n- Feature from 0.20 by @user in [#100](url)\n\n### Bug Fixes 🐛\n\n- Fix from 0.20 by @user in [#101](url)"
    ),
    makeRelease(
      "0.19.0",
      "### New Features ✨\n\n- Feature from 0.19 by @user in [#99](url)"
    ),
    makeRelease("0.18.0", "### Internal Changes 🔧\n\n- Only internal stuff"),
  ];

  test("filters releases within version range", () => {
    const summary = buildChangelogSummary(releases, "0.19.0", "0.21.0");
    expect(summary).not.toBeNull();
    // Should include 0.20.0 and 0.21.0 but not 0.19.0
    expect(summary!.sections.length).toBeGreaterThan(0);

    const featuresMarkdown =
      summary!.sections.find((s) => s.category === "features")?.markdown ?? "";
    expect(featuresMarkdown).toContain("Feature from 0.20");
    expect(featuresMarkdown).toContain("pagination");
    expect(featuresMarkdown).not.toContain("Feature from 0.19");
  });

  test("returns null when no releases in range", () => {
    expect(buildChangelogSummary(releases, "0.21.0", "0.22.0")).toBeNull();
  });

  test("returns null when all bodies are empty", () => {
    const emptyReleases = [makeRelease("0.21.0"), makeRelease("0.20.0", "")];
    expect(buildChangelogSummary(emptyReleases, "0.19.0", "0.21.0")).toBeNull();
  });

  test("returns null when only internal changes in range", () => {
    // 0.18.0 has only internal changes
    expect(buildChangelogSummary(releases, "0.17.0", "0.18.0")).toBeNull();
  });

  test("strips author attributions from entries", () => {
    const summary = buildChangelogSummary(releases, "0.19.0", "0.20.0");
    expect(summary).not.toBeNull();
    const allMarkdown = summary!.sections.map((s) => s.markdown).join("\n");
    expect(allMarkdown).not.toContain("by @user in");
  });

  test("merges same categories across releases", () => {
    const summary = buildChangelogSummary(releases, "0.18.0", "0.21.0");
    expect(summary).not.toBeNull();

    // Features from both 0.19, 0.20, and 0.21 should be in one section
    const features = summary!.sections.filter((s) => s.category === "features");
    expect(features).toHaveLength(1);
  });

  test("sections appear in order: features, fixes, performance", () => {
    const summary = buildChangelogSummary(releases, "0.18.0", "0.21.0");
    expect(summary).not.toBeNull();

    const categories = summary!.sections.map((s) => s.category);
    const featureIdx = categories.indexOf("features");
    const fixIdx = categories.indexOf("fixes");
    if (featureIdx >= 0 && fixIdx >= 0) {
      expect(featureIdx).toBeLessThan(fixIdx);
    }
  });

  test("handles v-prefix in tag names", () => {
    const vReleases = [
      makeRelease("v0.21.0", "### New Features ✨\n\n- Something new"),
    ];
    const summary = buildChangelogSummary(vReleases, "0.20.0", "0.21.0");
    expect(summary).not.toBeNull();
    expect(summary!.sections).toHaveLength(1);
  });

  test("truncation with maxItems", () => {
    const summary = buildChangelogSummary(releases, "0.18.0", "0.21.0", 3);
    expect(summary).not.toBeNull();
    expect(summary!.truncated).toBe(true);
    expect(summary!.totalItems).toBeLessThanOrEqual(3);
    expect(summary!.originalCount).toBeGreaterThan(3);
  });
});

// ──────────────────── parseCommitMessages ───────────────────────────────────

describe("parseCommitMessages", () => {
  test("groups by category correctly", () => {
    const commits = [
      { commit: { message: "feat: add new feature" } },
      { commit: { message: "fix: resolve bug" } },
      { commit: { message: "perf: optimize query" } },
      { commit: { message: "docs: update readme" } },
      { commit: { message: "chore: bump deps" } },
    ];

    const sections = parseCommitMessages(commits);
    const categories = sections.map((s) => s.category);

    expect(categories).toContain("features");
    expect(categories).toContain("fixes");
    expect(categories).toContain("performance");
    expect(sections).toHaveLength(3);
  });

  test("extracts scoped commit descriptions", () => {
    const commits = [
      { commit: { message: "feat(dashboard): add pagination support" } },
    ];

    const sections = parseCommitMessages(commits);
    expect(sections[0]!.markdown).toContain("add pagination support");
  });

  test("uses only first line of multi-line messages", () => {
    const commits = [
      {
        commit: {
          message:
            "feat: short summary\n\nLong description that should be ignored\n\nAnother paragraph",
        },
      },
    ];

    const sections = parseCommitMessages(commits);
    expect(sections[0]!.markdown).toContain("short summary");
    expect(sections[0]!.markdown).not.toContain("Long description");
  });

  test("filters #skip-changelog commits", () => {
    const commits = [
      { commit: { message: "feat: visible change" } },
      { commit: { message: "feat: hidden change\n\n#skip-changelog" } },
    ];

    const sections = parseCommitMessages(commits);
    const allMarkdown = sections.map((s) => s.markdown).join("\n");
    expect(allMarkdown).toContain("visible change");
    expect(allMarkdown).not.toContain("hidden change");
  });

  test("empty commits produce empty sections", () => {
    expect(parseCommitMessages([])).toEqual([]);
  });
});

// ──────────────────── extractNightlyTimestamp ───────────────────────────────

describe("extractNightlyTimestamp", () => {
  test("extracts timestamp from standard nightly format", () => {
    expect(extractNightlyTimestamp("0.22.0-dev.1772661724")).toBe(
      1_772_661_724
    );
  });

  test("returns null for stable versions", () => {
    expect(extractNightlyTimestamp("0.21.0")).toBeNull();
  });

  test("returns null for invalid format", () => {
    expect(extractNightlyTimestamp("not-a-version")).toBeNull();
    expect(extractNightlyTimestamp("")).toBeNull();
  });
});

// ──────────────────── countListItems ────────────────────────────────────────

describe("countListItems", () => {
  test("counts items in a simple list", () => {
    const tokens = marked.lexer("- item 1\n- item 2\n- item 3");
    expect(countListItems(tokens)).toBe(3);
  });

  test("returns 0 for non-list content", () => {
    const tokens = marked.lexer("Just a paragraph.");
    expect(countListItems(tokens)).toBe(0);
  });

  test("returns 0 for empty token array", () => {
    expect(countListItems([])).toBe(0);
  });
});

describe("fetchChangelog source affinity", () => {
  const toolkitSource = UPGRADE_SOURCES[0]!;
  const legacySource = UPGRADE_SOURCES[1]!;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("fetches stable releases only from the explicitly selected Toolkit source", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify([
          makeRelease(
            "mcp@99.0.0",
            "### New Features ✨\n\n- Unrelated Toolkit package release"
          ),
          makeRelease(
            "0.21.0",
            "### Bug Fixes 🐛\n\n- Unprefixed Toolkit release"
          ),
          makeRelease(
            "cli@0.21.0",
            "### Bug Fixes 🐛\n\n- Keep release stages source-affine"
          ),
        ]),
        { status: 200 }
      );
    });

    const changelog = await fetchChangelog({
      channel: "stable",
      fromVersion: "0.20.0",
      toVersion: "0.21.0",
      source: toolkitSource,
    });

    expect(changelog?.totalItems).toBe(1);
    expect(changelog?.sections[0]?.markdown).not.toContain(
      "Unrelated Toolkit package release"
    );
    expect(changelog?.sections[0]?.markdown).not.toContain(
      "Unprefixed Toolkit release"
    );
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/releases?per_page=30",
    ]);
    expect(requestedUrls.some((url) => url.includes("getsentry/cli"))).toBe(
      false
    );
  });

  test("builds a Toolkit changelog from normalized prefetched releases", async () => {
    globalThis.fetch = mockFetch(
      async () =>
        new Response(
          JSON.stringify([
            makeRelease(
              "cli@0.21.0",
              "### Bug Fixes 🐛\n\n- Reuse prefetched releases"
            ),
          ]),
          { status: 200 }
        )
    );

    const releases = await fetchRecentReleases(undefined, toolkitSource);
    const changelog = await fetchChangelog({
      channel: "stable",
      fromVersion: "0.20.0",
      toVersion: "0.21.0",
      source: { ...toolkitSource },
      prefetchedReleases: releases,
    });

    expect(changelog?.totalItems).toBe(1);
    expect(changelog?.sections[0]?.markdown).toContain(
      "Reuse prefetched releases"
    );
  });

  test("rejects normalized releases from another source", async () => {
    const releases = await fetchRecentReleases(undefined, toolkitSource);
    const changelog = await fetchChangelog({
      channel: "stable",
      fromVersion: "0.20.0",
      toVersion: "0.21.0",
      source: UPGRADE_SOURCES[1],
      prefetchedReleases: releases,
    });

    expect(changelog).toBeNull();
  });

  test("rejects raw prefetched Toolkit releases without fetching", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requestedUrls.push(String(input));
      return new Response("Unexpected", { status: 500 });
    });

    const changelog = await fetchChangelog({
      channel: "stable",
      fromVersion: "0.20.0",
      toVersion: "0.21.0",
      source: toolkitSource,
      prefetchedReleases: [
        makeRelease("mcp@0.21.0", "- Unrelated MCP release"),
        makeRelease(
          "cli@0.21.0",
          "### Bug Fixes 🐛\n\n- Raw prefetched release"
        ),
      ] as never,
    });

    expect(changelog).toBeNull();
    expect(requestedUrls).toEqual([]);
  });

  test("rejects unprefixed raw prefetched releases for Toolkit", async () => {
    const changelog = await fetchChangelog({
      channel: "stable",
      fromVersion: "0.20.0",
      toVersion: "0.21.0",
      source: toolkitSource,
      prefetchedReleases: [
        makeRelease("0.21.0", "### Bug Fixes 🐛\n\n- Legacy release"),
      ] as never,
    });

    expect(changelog).toBeNull();
  });

  test("excludes semantic prereleases from stable changelogs", async () => {
    const changelog = await fetchChangelog({
      channel: "stable",
      fromVersion: "0.20.0",
      toVersion: "0.21.0",
      source: toolkitSource,
      prefetchedReleases: [
        makeRelease("cli@0.21.0-dev.1", "- Development release"),
        makeRelease("cli@0.21.0", "### Bug Fixes 🐛\n\n- Stable release"),
      ] as never,
    });

    expect(changelog).toBeNull();
  });

  test("fetches stable releases only from the explicitly selected legacy source", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify([
          makeRelease(
            "0.21.0",
            "### Bug Fixes 🐛\n\n- Keep the legacy bridge working"
          ),
        ]),
        { status: 200 }
      );
    });

    const changelog = await fetchChangelog({
      channel: "stable",
      fromVersion: "0.20.0",
      toVersion: "0.21.0",
      source: legacySource,
    });

    expect(changelog?.totalItems).toBe(1);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/getsentry/cli/releases?per_page=30",
    ]);
  });

  test("fetches nightly commits only from the explicitly selected Toolkit source", async () => {
    const requestedUrls: string[] = [];
    globalThis.fetch = mockFetch(async (input) => {
      requestedUrls.push(String(input));
      return new Response(
        JSON.stringify([
          { commit: { message: "fix: keep nightly stages affine" } },
        ]),
        { status: 200 }
      );
    });

    const changelog = await fetchChangelog({
      channel: "nightly",
      fromVersion: "0.21.0-dev.100",
      toVersion: "0.21.0-dev.200",
      source: toolkitSource,
    });

    expect(changelog?.totalItems).toBe(1);
    expect(requestedUrls).toEqual([
      "https://api.github.com/repos/getsentry/toolkit/commits?sha=main&since=1970-01-01T00:01:41.000Z&until=1970-01-01T00:03:21.000Z&per_page=100",
    ]);
    expect(requestedUrls.some((url) => url.includes("getsentry/cli"))).toBe(
      false
    );
  });
});
