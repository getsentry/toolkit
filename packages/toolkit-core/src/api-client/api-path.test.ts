import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { UserInputError } from "./errors.js";
import { apiPath } from "./api-path.js";

/**
 * Resolves a path the way `fetch` does. Dot-segment normalization happens during URL
 * parsing rather than in our code, so a test that only inspected the assembled string
 * would pass even if traversal still worked.
 */
function resolve(path: string): string {
  const url = new URL(`https://sentry.io/api/0${path}`);
  return url.pathname + url.search;
}

describe("apiPath", () => {
  it("leaves legitimate identifier formats byte for byte", () => {
    for (const value of [
      "my-org",
      "my_project.name",
      "1234567890",
      "cfe78a5c892d4a64a962d837673398d2",
      "7e07485f-12f9-416b-8b14-26260799b51f",
      "PROJECT-1Z43",
      "latest",
    ]) {
      expect(apiPath`/projects/${value}/`).toBe(`/projects/${value}/`);
    }
  });

  it("resolves an unencoded payload out of scope, proving these tests are meaningful", () => {
    const attack = "../../../victim-org/victim-proj/events/abc";

    expect(resolve(`/projects/my-org/my-proj/events/${attack}/`)).toBe(
      "/api/0/projects/victim-org/victim-proj/events/abc/",
    );
  });

  /**
   * VULN-2450 asked that any patch be retested against these variants, since
   * encode-only fixes for this class have historically been bypassable.
   *
   * Asserting the whole resolved path is what proves containment. Searching for the
   * payload text would not, since an encoded payload still contains it as literal text.
   */
  it.each([
    ["plain dot segments", "../../other-org"],
    ["double encoded dots", "%252e%252e%252fother-org"],
    ["single encoded dots", "%2e%2e%2fother-org"],
    ["recursive sequences", "....//....//other-org"],
    ["backslash separators", "..\\..\\other-org"],
    ["null byte", "abc\u0000/../other-org"],
    ["fragment truncation", "abc/#"],
    ["query injection", "abc/?download=1&x=2"],
    ["scheme relative", "//evil.example.com/x"],
    ["absolute path", "/organizations/other-org/members"],
    ["trailing dot segment", "abc/.."],
    ["dots with a suffix", "..a"],
  ])("contains %s in a single segment", (_label, attack) => {
    expect(resolve(apiPath`/projects/my-org/my-proj/events/${attack}/`)).toBe(
      `/api/0/projects/my-org/my-proj/events/${encodeURIComponent(attack)}/`,
    );
  });

  /**
   * A bare dot segment carries no separator, so encoding leaves it intact and the URL
   * parser still collapses it. It cannot name another tenant, but it does consume a
   * preceding segment, so it has to be rejected rather than encoded.
   */
  describe("bare dot segments", () => {
    it.each([".", ".."])("rejects %s", (attack) => {
      expect(() => apiPath`/projects/o/p/keys/${attack}/`).toThrow(
        UserInputError,
      );
    });

    it("would otherwise consume the preceding segment", () => {
      expect(resolve("/projects/o/p/keys/../")).toBe("/api/0/projects/o/p/");
      expect(resolve("/projects/o/p/keys/%2e%2e/")).toBe(
        "/api/0/projects/o/p/",
      );
    });

    it("accepts values that merely contain dots, including encoded spellings", () => {
      // `%2e%2e` as input is inert once the `%` is itself encoded, so rejecting it
      // would refuse a value that is already safe.
      for (const value of ["1.2.3", "my.project", "...", "%2e%2e"]) {
        expect(() => apiPath`/projects/o/p/keys/${value}/`).not.toThrow();
      }
    });
  });
});

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
