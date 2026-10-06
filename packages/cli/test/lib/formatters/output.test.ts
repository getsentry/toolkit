import { describe, expect, test } from "vitest";
import {
  type OutputConfig,
  renderCommandOutput,
  resolveRenderer,
  writeFooter,
} from "../../../src/lib/formatters/output.js";

/** Collect all writes for assertions (string or binary). */
function createTestWriter() {
  const chunks: Array<string | Uint8Array> = [];
  return {
    write(data: string | Uint8Array) {
      chunks.push(data);
      return true;
    },
    chunks,
    /** Full concatenated string output (binary chunks decoded as latin1). */
    get output() {
      return chunks
        .map((c) =>
          typeof c === "string" ? c : Buffer.from(c).toString("latin1")
        )
        .join("");
    },
    /** Concatenated raw bytes from all writes. */
    get bytes() {
      const parts = chunks.map((c) =>
        typeof c === "string" ? Buffer.from(c, "utf8") : Buffer.from(c)
      );
      return Buffer.concat(parts);
    },
  };
}

/**
 * Test helper: calls renderCommandOutput with a fresh renderer resolved
 * from the config. Mirrors the real wrapper's per-invocation resolve.
 */
function render(
  w: ReturnType<typeof createTestWriter>,
  data: unknown,
  config: OutputConfig<any>,
  ctx: { json: boolean; fields?: string[] }
) {
  const renderer = resolveRenderer(config.human);
  renderCommandOutput(w, data, config, renderer, ctx);
}

describe("writeFooter", () => {
  test("writes empty line followed by muted text", () => {
    const w = createTestWriter();
    writeFooter(w, "Some hint");
    const output = w.chunks.join("");
    expect(output).toStartWith("\n");
    expect(output).toContain("Some hint");
    expect(output).toEndWith("\n");
  });
});

// ---------------------------------------------------------------------------
// Return-based output (renderCommandOutput)
// ---------------------------------------------------------------------------

describe("renderCommandOutput", () => {
  test("renders JSON when json=true", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ id: number; name: string }> = {
      human: (d) => `${d.name}`,
    };
    render(w, { id: 1, name: "Alice" }, config, { json: true });
    expect(JSON.parse(w.output)).toEqual({ id: 1, name: "Alice" });
  });

  test("renders human output when json=false", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ name: string }> = {
      human: (d) => `Hello ${d.name}`,
    };
    render(w, { name: "Alice" }, config, { json: false });
    expect(w.output).toBe("Hello Alice\n");
  });

  test("applies fields filtering in JSON mode", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ id: number; name: string; secret: string }> = {
      human: (_d) => "unused",
    };
    render(w, { id: 1, name: "Alice", secret: "x" }, config, {
      json: true,
      fields: ["id", "name"],
    });
    expect(JSON.parse(w.output)).toEqual({ id: 1, name: "Alice" });
  });

  test("does not render hints (hints are rendered by the wrapper after generator completes)", () => {
    const w = createTestWriter();
    const config: OutputConfig<string> = {
      human: (_d) => "Result",
    };
    // renderCommandOutput only renders data — hints are handled by
    // buildCommand's wrapper via the generator return value
    render(w, "data", config, { json: false });
    expect(w.output).toBe("Result\n");
  });

  test("works without hint", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ value: number }> = {
      human: (d) => `Value: ${d.value}`,
    };
    render(w, { value: 42 }, config, { json: false });
    expect(w.output).toBe("Value: 42\n");
  });

  test("streams Uint8Array binary bodies raw with no trailing newline", () => {
    const w = createTestWriter();
    const config: OutputConfig<unknown> = {
      human: () => "SHOULD_NOT_RUN",
    };
    // Real PNG signature — proves no UTF-8 replacement and no formatter path.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    render(w, png, config, { json: false });
    expect(w.chunks).toHaveLength(1);
    expect(w.chunks[0]).toBeInstanceOf(Uint8Array);
    expect(Array.from(w.bytes)).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    // No trailing newline added by the text formatter path
    expect(w.bytes.length).toBe(8);
  });

  test("streams Uint8Array even when json=true (binary bypasses JSON)", () => {
    const w = createTestWriter();
    const config: OutputConfig<unknown> = {
      human: () => "SHOULD_NOT_RUN",
    };
    const bytes = new Uint8Array([0xff, 0x00, 0x80]);
    render(w, bytes, config, { json: true });
    expect(Array.from(w.bytes)).toEqual([0xff, 0x00, 0x80]);
  });

  test("jsonExclude strips fields from JSON output", () => {
    const w = createTestWriter();
    const config: OutputConfig<{
      id: number;
      name: string;
      spanTreeLines?: string[];
    }> = {
      human: (d) => `${d.id}: ${d.name}`,
      jsonExclude: ["spanTreeLines"],
    };
    render(
      w,
      { id: 1, name: "Alice", spanTreeLines: ["line1", "line2"] },
      config,
      { json: true }
    );
    const parsed = JSON.parse(w.output);
    expect(parsed).toEqual({ id: 1, name: "Alice" });
    expect(parsed).not.toHaveProperty("spanTreeLines");
  });

  test("jsonExclude does not affect human output", () => {
    const w = createTestWriter();
    const config: OutputConfig<{
      id: number;
      spanTreeLines?: string[];
    }> = {
      human: (d) =>
        `${d.id}\n${d.spanTreeLines ? d.spanTreeLines.join("\n") : ""}`,
      jsonExclude: ["spanTreeLines"],
    };
    render(w, { id: 1, spanTreeLines: ["line1", "line2"] }, config, {
      json: false,
    });
    expect(w.output).toContain("line1");
    expect(w.output).toContain("line2");
  });

  test("jsonExclude with empty array is a no-op", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ id: number; extra: string }> = {
      human: (d) => `${d.id}`,
      jsonExclude: [],
    };
    render(w, { id: 1, extra: "keep" }, config, { json: true });
    const parsed = JSON.parse(w.output);
    expect(parsed).toEqual({ id: 1, extra: "keep" });
  });

  test("jsonExclude strips fields from array elements", () => {
    const w = createTestWriter();
    const config: OutputConfig<any> = {
      human: (d: { id: number; name: string }[]) =>
        d.map((e) => e.name).join(", "),
      jsonExclude: ["detectedFrom"],
    };
    render(
      w,
      [
        { id: 1, name: "a", detectedFrom: "dsn" },
        { id: 2, name: "b" },
      ],
      config,
      { json: true }
    );
    const parsed = JSON.parse(w.output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
  });

  test("jsonTransform reshapes data for JSON output", () => {
    const w = createTestWriter();
    type ListResult = {
      items: { id: number; name: string }[];
      hasMore: boolean;
      org: string;
    };
    const config: OutputConfig<ListResult> = {
      human: (d) => d.items.map((i) => i.name).join(", "),
      jsonTransform: (data) => ({
        data: data.items,
        hasMore: data.hasMore,
      }),
    };
    render(
      w,
      { items: [{ id: 1, name: "Alice" }], hasMore: true, org: "test-org" },
      config,
      { json: true }
    );
    const parsed = JSON.parse(w.output);
    expect(parsed).toEqual({
      data: [{ id: 1, name: "Alice" }],
      hasMore: true,
    });
    // org should not appear (transform omits it)
    expect(parsed).not.toHaveProperty("org");
  });

  test("jsonTransform receives fields for per-element filtering", () => {
    const w = createTestWriter();
    type ListResult = {
      items: { id: number; name: string; secret: string }[];
      hasMore: boolean;
    };
    const config: OutputConfig<ListResult> = {
      human: (_d) => "unused",
      jsonTransform: (data, fields) => ({
        data:
          fields && fields.length > 0
            ? data.items.map((item) => {
                const filtered: Record<string, unknown> = {};
                for (const f of fields) {
                  if (f in item) {
                    filtered[f] = (item as Record<string, unknown>)[f];
                  }
                }
                return filtered;
              })
            : data.items,
        hasMore: data.hasMore,
      }),
    };
    render(
      w,
      {
        items: [{ id: 1, name: "Alice", secret: "x" }],
        hasMore: false,
      },
      config,
      { json: true, fields: ["id", "name"] }
    );
    const parsed = JSON.parse(w.output);
    expect(parsed.data[0]).toEqual({ id: 1, name: "Alice" });
    expect(parsed.data[0]).not.toHaveProperty("secret");
  });

  test("jsonTransform is ignored in human mode", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ items: string[]; org: string }> = {
      human: (d) => `${d.org}: ${d.items.join(", ")}`,
      jsonTransform: (data) => ({ data: data.items }),
    };
    render(w, { items: ["a", "b"], org: "test-org" }, config, {
      json: false,
    });
    expect(w.output).toBe("test-org: a, b\n");
  });

  test("jsonTransform takes precedence over jsonExclude", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ id: number; name: string; extra: string }> = {
      human: (_d) => "unused",
      jsonExclude: ["extra"],
      jsonTransform: (data) => ({ transformed: true, id: data.id }),
    };
    render(w, { id: 1, name: "Alice", extra: "kept-by-transform" }, config, {
      json: true,
    });
    const parsed = JSON.parse(w.output);
    // jsonTransform output, not jsonExclude
    expect(parsed).toEqual({ transformed: true, id: 1 });
  });

  test("human factory creates fresh renderer per resolve", () => {
    const calls: number[] = [];
    const config: OutputConfig<{ n: number }> = {
      human: () => ({
        render: (d) => {
          calls.push(d.n);
          return `#${d.n}`;
        },
      }),
    };

    // First resolve + render
    const r1 = resolveRenderer(config.human);
    r1.render({ n: 1 });

    // Second resolve = fresh renderer
    const r2 = resolveRenderer(config.human);
    r2.render({ n: 2 });

    expect(calls).toEqual([1, 2]);
  });

  test("finalize is called with hint and output is written", () => {
    const w = createTestWriter();
    const config: OutputConfig<{ value: string }> = {
      human: () => ({
        render: (d) => `[${d.value}]`,
        finalize: (hint) => `=== END ===${hint ? `\n${hint}` : ""}`,
      }),
    };

    const renderer = resolveRenderer(config.human);
    renderCommandOutput(w, { value: "test" }, config, renderer, {
      json: false,
    });
    expect(w.output).toBe("[test]\n");

    // Simulate finalize
    const footer = renderer.finalize?.("Done.");
    expect(footer).toBe("=== END ===\nDone.");
  });

  test("plain function renderer has no finalize method", () => {
    const config: OutputConfig<string> = {
      human: (s) => s.toUpperCase(),
    };
    const renderer = resolveRenderer(config.human);
    expect(renderer.render("hello")).toBe("HELLO");
    expect(renderer.finalize).toBeUndefined();
  });
});
