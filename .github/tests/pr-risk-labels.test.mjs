import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Execute the actual workflow script so the tests cannot drift from production.
const workflow = readFileSync(
  new URL("../workflows/pr-risk-jev.yml", import.meta.url),
  "utf8",
);
const script = workflow.match(/^ {10}script: \|\n((?: {12}.*\n|\n)+)/m)?.[1];
assert.ok(script, "Publish risk label script must exist");
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const publish = new AsyncFunction(
  "require",
  "github",
  "context",
  "core",
  script,
);
const require = createRequire(import.meta.url);
const repo = { owner: "example", repo: "cli" };
const head = "a".repeat(40);
const base = "b".repeat(40);

async function withPR(options, check) {
  const directory = mkdtempSync(join(tmpdir(), "pr-risk-labels-"));
  const previousDirectory = process.cwd();
  const previousNumber = process.env.PR_NUMBER;
  const labels = new Set(options.labels ?? ["area: auth", "risk: high"]);
  const repositoryLabels = new Set(
    options.repositoryLabels ?? ["risk: low", "risk: medium", "risk: high"],
  );
  const writes = [];
  const warnings = [];
  const pr = {
    state: "open",
    head: { sha: head },
    base: { sha: base },
    title: "Update behavior",
    body: "Describe this change",
    ...options.pr,
  };
  const result = {
    repo: "example/cli",
    number: 42,
    status: "ok",
    risk_label: "low",
    snapshot: { source_head_sha: head, source_base_sha: base },
    ...options.result,
  };
  const error = (status) =>
    Object.assign(new Error(`GitHub HTTP ${status}`), { status });
  const github = {
    rest: {
      pulls: {
        get: async () => ({
          data: structuredClone({
            ...pr,
            labels: [...labels].map((name) => ({ name })),
          }),
        }),
      },
      issues: {
        getLabel: async ({ name }) => {
          if (!repositoryLabels.has(name)) throw error(404);
          return { data: { name } };
        },
        createLabel: async ({ name }) => {
          repositoryLabels.add(name);
          if (options.createRace) throw error(422);
          return { data: { name } };
        },
        addLabels: async ({ labels: added }) => {
          writes.push(["add", ...added]);
          for (const label of added) labels.add(label);
          options.afterAdd?.(pr);
        },
        removeLabel: async ({ name }) => {
          writes.push(["remove", name]);
          if (!labels.delete(name)) throw error(404);
        },
      },
    },
  };
  try {
    process.chdir(directory);
    process.env.PR_NUMBER = "42";
    if (!options.missingResult)
      writeFileSync("risk-pr-result.json", JSON.stringify(result));
    await check({
      run: () =>
        publish(
          require,
          github,
          { repo },
          { warning: (message) => warnings.push(message), info: () => {} },
        ),
      labels,
      writes,
      warnings,
    });
  } finally {
    process.chdir(previousDirectory);
    if (previousNumber === undefined) delete process.env.PR_NUMBER;
    else process.env.PR_NUMBER = previousNumber;
    rmSync(directory, { recursive: true, force: true });
  }
}

for (const risk of ["low", "medium", "high"]) {
  test(`publishes ${risk}, replacing only risk labels`, async () => {
    await withPR(
      {
        result: { risk_label: risk },
        labels: ["area: auth", "risk: low", "risk: medium", "risk: high"],
      },
      async ({ run, labels }) => {
        await run();
        assert.deepEqual(
          [...labels].sort((a, b) => a.localeCompare(b)),
          ["area: auth", `risk: ${risk}`],
        );
      },
    );
  });
}

test("context rejection removes stale risk labels and remains unclassified", async () => {
  await withPR(
    { result: { status: "context_rejected", risk_label: null } },
    async ({ run, labels, warnings }) => {
      await run();
      assert.deepEqual([...labels], ["area: auth"]);
      assert.ok(warnings.some((message) => message.includes("unclassified")));
    },
  );
});

test("moved or closed PRs are left untouched before publication", async (t) => {
  for (const pr of [
    { head: { sha: "c".repeat(40) } },
    { base: { sha: "d".repeat(40) } },
    { state: "closed" },
  ]) {
    await t.test(JSON.stringify(pr), async () => {
      await withPR({ pr }, async ({ run, labels, writes }) => {
        await run();
        assert.deepEqual(writes, []);
        assert.deepEqual([...labels], ["area: auth", "risk: high"]);
      });
    });
  }
});

test("movement or metadata edits during publication roll back the verdict", async (t) => {
  for (const [name, afterAdd] of [
    [
      "head",
      (pr) => {
        pr.head.sha = "c".repeat(40);
      },
    ],
    [
      "title",
      (pr) => {
        pr.title = "A different change";
      },
    ],
    [
      "closed",
      (pr) => {
        pr.state = "closed";
      },
    ],
  ]) {
    await t.test(name, async () => {
      await withPR({ afterAdd }, async ({ run, labels }) => {
        await run();
        assert.deepEqual([...labels], ["area: auth"]);
      });
    });
  }
});

test("results for another PR or an invalid risk cannot publish", async (t) => {
  for (const result of [
    { repo: "example/another" },
    { number: 43 },
    { risk_label: "critical" },
    { risk_label: "toString" },
  ]) {
    await t.test(JSON.stringify(result), async () => {
      await withPR({ result }, async ({ run, writes }) => {
        await assert.rejects(run, /does not match/);
        assert.deepEqual(writes, []);
      });
    });
  }
});

test("a missing result does not publish or remove labels", async () => {
  await withPR({ missingResult: true }, async ({ run, writes, warnings }) => {
    await run();
    assert.deepEqual(writes, []);
    assert.equal(warnings.length, 1);
  });
});

test("concurrent repository label creation still publishes", async () => {
  await withPR(
    { repositoryLabels: [], createRace: true },
    async ({ run, labels }) => {
      await run();
      assert.deepEqual([...labels], ["area: auth", "risk: low"]);
    },
  );
});

for (const risk of ["low", "medium", "high"]) {
  test(`unchanged ${risk} leaves the PR timeline untouched`, async () => {
    await withPR(
      { result: { risk_label: risk }, labels: ["area: auth", `risk: ${risk}`] },
      async ({ run, labels, writes }) => {
        await run();
        assert.deepEqual(writes, []);
        assert.deepEqual([...labels], ["area: auth", `risk: ${risk}`]);
      },
    );
  });
}

test("an existing verdict removes competing risk labels without re-adding itself", async () => {
  await withPR(
    {
      result: { risk_label: "medium" },
      labels: ["area: auth", "risk: medium", "risk: high"],
    },
    async ({ run, labels, writes }) => {
      await run();
      assert.deepEqual(writes, [["remove", "risk: high"]]);
      assert.deepEqual([...labels], ["area: auth", "risk: medium"]);
    },
  );
});

test("a second identical publication makes no label mutations", async () => {
  await withPR({}, async ({ run, labels, writes }) => {
    await run();
    assert.deepEqual([...labels], ["area: auth", "risk: low"]);
    writes.length = 0;
    await run();
    assert.deepEqual(writes, []);
    assert.deepEqual([...labels], ["area: auth", "risk: low"]);
  });
});
