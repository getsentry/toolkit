import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The slug-only fix in VULN-848 hardened the parameters that were vulnerable at the
 * time and left the resource IDs raw, which is how VULN-2159/2450 happened ten months
 * later. Enumerating parameters does not hold; enforcing the invariant does.
 *
 * This fails on any new request path that interpolates a value without the `apiPath`
 * tag, so the class cannot be reintroduced by a tool author unaware of it.
 */
describe("client.ts request path invariant", () => {
  const source = readFileSync(new URL("./client.ts", import.meta.url), "utf8");

  /**
   * Returns the path portion of a template literal body, stopping at the query
   * separator. Only interpolation before the `?` needs the tag; query values are
   * already encoded by `URLSearchParams` and must keep their separators literal.
   */
  function pathPortion(body: string): string {
    let depth = 0;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === "$" && body[i + 1] === "{") {
        depth++;
        i++;
      } else if (body[i] === "}" && depth > 0) {
        depth--;
      } else if (body[i] === "?" && depth === 0) {
        return body.slice(0, i);
      }
    }
    return body;
  }

  it("interpolates every request path through apiPath", () => {
    const offenders: string[] = [];

    source.split("\n").forEach((line, index) => {
      const trimmed = line.trim();
      if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;

      // A template literal opening with a slash is an API request path.
      for (let i = 0; i < line.length - 1; i++) {
        if (line[i] !== "`" || line[i + 1] !== "/") continue;

        const closing = line.indexOf("`", i + 1);
        const body = line.slice(i + 1, closing === -1 ? undefined : closing);

        if (
          !line.slice(0, i).endsWith("apiPath") &&
          /\$\{/.test(pathPortion(body))
        ) {
          offenders.push(`${index + 1}: ${trimmed}`);
        }
      }
    });

    expect(
      offenders,
      `Request paths must be built with the apiPath tag so interpolated values cannot escape their segment:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("does not double-encode inside an apiPath template", () => {
    const doubleEncoded = [...source.matchAll(/apiPath`[^`]*`/g)]
      .map((match) => match[0])
      .filter((template) => template.includes("encodeURIComponent"));

    expect(doubleEncoded).toEqual([]);
  });
});
