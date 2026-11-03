/** Real legacy catalogs, native pixel decoding, and the production SEA binary. */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { strToU8, unzipSync, zipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildCarExtract } from "../../../script/build-car-extract.js";
import {
  type AssetCatalogEntry,
  extractAssetCatalogImages,
} from "../../../src/lib/build/asset-catalog-extract.js";
import {
  normalizeBuildDirectory,
  normalizeIpa,
} from "../../../src/lib/build/index.js";

const run = promisify(execFile);
const FIXTURES = fileURLToPath(
  new URL("../../fixtures/build/asset-catalog/", import.meta.url),
);
const CATALOG_PATH = "Products/Applications/DemoApp.app/Assets.car";
const PARSED_PATH = "ParsedAssets/Products/Applications/DemoApp.app";
const state = { directory: "", helper: "", universalArchive: "" };
const CATALOG_IDIOMS = ["phone", "universal"] as const;
type CatalogIdiom = (typeof CATALOG_IDIOMS)[number];

/** Compile an explicitly universal image so the zero-idiom regression has known input. */
async function compileUniversalCatalog(directory: string): Promise<string> {
  const xcassets = join(directory, "Universal.xcassets");
  const imageset = join(xcassets, "Universal.imageset");
  const archive = join(directory, "Universal.xcarchive");
  const compiled = join(archive, "Products/Applications/DemoApp.app");
  await mkdir(imageset, { recursive: true });
  await mkdir(compiled, { recursive: true });
  const info = { author: "xcode", version: 1 };
  await writeFile(join(xcassets, "Contents.json"), JSON.stringify({ info }));
  await writeFile(
    join(imageset, "Contents.json"),
    JSON.stringify({
      images: [{ idiom: "universal", scale: "1x", filename: "universal.png" }],
      info,
    }),
  );
  // A valid 10x10 PNG; actool produces the real binary catalog from this image.
  await writeFile(
    join(imageset, "universal.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFElEQVR4nGM4IafxnxjMMKqQvgoBIgzNFQJIdHQAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await run(
    "xcrun",
    [
      "actool",
      xcassets,
      "--compile",
      compiled,
      "--platform",
      "iphoneos",
      "--minimum-deployment-target",
      "15.0",
      "--output-format",
      "human-readable-text",
    ],
    { timeout: 60_000 },
  );
  return archive;
}

function catalogArchive(idiom: CatalogIdiom): string {
  return idiom === "phone"
    ? join(FIXTURES, "archive.xcarchive")
    : state.universalArchive;
}

async function manifest(path: string): Promise<AssetCatalogEntry[]> {
  return JSON.parse(await readFile(path, "utf8")) as AssetCatalogEntry[];
}

function assertParsedAssets(
  entries: Record<string, Uint8Array>,
  archiveName: string,
  expectedIdiom: CatalogIdiom,
): void {
  const prefix = `${archiveName}/${PARSED_PATH}`;
  const manifestBytes = entries[`${prefix}/Assets.json`];
  expect(manifestBytes).toBeDefined();
  const assets = JSON.parse(
    new TextDecoder().decode(manifestBytes),
  ) as AssetCatalogEntry[];
  expect(assets.length).toBeGreaterThan(1);
  expect(assets).toContainEqual(
    expect.objectContaining({ idiom: expectedIdiom }),
  );
  expect(assets).toContainEqual(
    expect.objectContaining({ imageId: "", vector: false }),
  );
  const images = Object.keys(entries).filter(
    (path) => path.startsWith(`${prefix}/`) && !path.endsWith("Assets.json"),
  );
  expect(images.length).toBeGreaterThan(0);
  for (const imagePath of images) {
    const name = imagePath.slice(prefix.length + 1);
    const dot = name.lastIndexOf(".");
    const imageId = name.slice(0, dot);
    const asset = assets.find((item) => item.imageId === imageId);
    expect(asset).toBeDefined();
    expect(name).toMatch(
      /^[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\.[a-z]+$/,
    );
    if (imagePath.endsWith(".png")) {
      const image = Buffer.from(entries[imagePath] ?? []);
      expect([...image.subarray(0, 8)]).toEqual([
        137, 80, 78, 71, 13, 10, 26, 10,
      ]);
      expect(image.readUInt32BE(16)).toBe(asset?.width);
      expect(image.readUInt32BE(20)).toBe(asset?.height);
    }
  }
}

// CoreUI is an OS framework. Unsupported platforms skip; macOS arm64 always
// builds and exercises it, and a missing toolchain must fail rather than skip.
describe.skipIf(process.platform !== "darwin" || process.arch !== "arm64")(
  "real asset-catalog extraction",
  () => {
    beforeAll(async () => {
      state.directory = await mkdtemp(join(tmpdir(), "car-integration-"));
      state.helper = buildCarExtract();
      state.universalArchive = await compileUniversalCatalog(state.directory);
    }, 120_000);
    afterAll(async () => {
      if (state.directory) {
        await rm(state.directory, { recursive: true, force: true });
      }
    });

    test("matches the legacy Swift fixture's two-entry manifest and decodes real pixels", async () => {
      const source = join(FIXTURES, "test.xcarchive", CATALOG_PATH);
      const output = join(state.directory, "native-small");
      await run(state.helper, [source, output]);
      const directory = join(output, "Products/Applications/DemoApp.app");
      const assets = await manifest(join(directory, "Assets.json"));
      expect(assets).toHaveLength(2); // The upstream Swift test asserts this exact count.
      const image = assets.find((asset) => asset.imageId !== "");
      expect(image).toEqual(
        expect.objectContaining({
          size: expect.any(Number),
          vector: false,
          width: expect.any(Number),
          height: expect.any(Number),
        }),
      );
      if (!image) {
        throw new Error("Legacy fixture did not decode an image");
      }
      const extension =
        extname(image.filename ?? "")
          .slice(1)
          .toLowerCase() || "png";
      const path = join(directory, `${image.imageId}.${extension}`);
      const bytes = await readFile(path);
      expect(bytes.length).toBeGreaterThan(8);
      if (extension === "png") {
        expect([...bytes.subarray(0, 8)]).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
      }
    }, 30_000);

    test.each(CATALOG_IDIOMS)(
      "expands the %s XCArchive catalog and keeps repeated uploads identical",
      async (idiom) => {
        const source = catalogArchive(idiom);
        const first = join(state.directory, `${idiom}-first.zip`);
        const second = join(state.directory, `${idiom}-second.zip`);
        await normalizeBuildDirectory(source, first, null);
        await normalizeBuildDirectory(source, second, null);
        const firstBytes = await readFile(first);
        expect(firstBytes).toEqual(await readFile(second));
        const entries = unzipSync(firstBytes);
        assertParsedAssets(entries, basename(source), idiom);
        expect(entries[`${basename(source)}/${CATALOG_PATH}`]).toEqual(
          new Uint8Array(await readFile(join(source, CATALOG_PATH))),
        );
      },
      60_000,
    );

    test.each(CATALOG_IDIOMS)(
      "expands an IPA carrying the %s catalog",
      async (idiom) => {
        const source = join(state.directory, `Demo-${idiom}.ipa`);
        const catalog = await readFile(
          join(catalogArchive(idiom), CATALOG_PATH),
        );
        await writeFile(
          source,
          zipSync({
            "Payload/DemoApp.app/Info.plist": strToU8("<plist/>"),
            "Payload/DemoApp.app/Assets.car": catalog,
          }),
        );
        const output = join(state.directory, `ipa-${idiom}.zip`);
        await normalizeIpa(source, output, null);
        const entries = unzipSync(await readFile(output));
        assertParsedAssets(entries, "archive.xcarchive", idiom);
        expect(entries[`archive.xcarchive/${CATALOG_PATH}`]).toEqual(
          new Uint8Array(catalog),
        );
      },
      30_000,
    );

    test("keeps a corrupt real catalog nonfatal", async () => {
      const catalog = join(state.directory, "broken.car");
      await writeFile(
        catalog,
        (
          await readFile(join(FIXTURES, "test.xcarchive", CATALOG_PATH))
        ).subarray(0, 64),
      );
      expect(await extractAssetCatalogImages(CATALOG_PATH, catalog)).toBeNull();
    }, 30_000);

    test
      .runIf(Boolean(process.env.SENTRY_CAR_TEST_BINARY))
      .each(CATALOG_IDIOMS)(
      "uploads %s images through the helper embedded in the standalone binary",
      async (idiom) => {
        const binary = process.env.SENTRY_CAR_TEST_BINARY;
        if (!binary) {
          throw new Error("Missing native test binary");
        }
        const source = join(state.directory, `Embedded-${idiom}.xcarchive`);
        await cp(catalogArchive(idiom), source, {
          recursive: true,
        });
        await writeFile(join(source, "Info.plist"), "<plist/>");
        await writeFile(
          join(source, "Products/Applications/DemoApp.app/Info.plist"),
          "<plist/>",
        );
        const uploaded: Uint8Array[] = [];
        const unexpected: string[] = [];
        const fixtureState = { origin: "", errors: 0 };
        const server = createServer(async (request, response) => {
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Connection", "close");
          try {
            const buffers: Buffer[] = [];
            for await (const chunk of request) {
              buffers.push(Buffer.from(chunk));
            }
            const body = Buffer.concat(buffers);
            if (request.url === "/api/0/organizations/test-org/") {
              response.end(
                JSON.stringify({
                  id: "1",
                  slug: "test-org",
                  name: "Test",
                  links: { regionUrl: fixtureState.origin },
                }),
              );
            } else if (
              request.url === "/api/0/organizations/test-org/chunk-upload/"
            ) {
              response.end(
                JSON.stringify({
                  url: `${fixtureState.origin}/chunks/`,
                  chunkSize: 16 * 1024 * 1024,
                  chunksPerRequest: 1,
                  maxRequestSize: 32 * 1024 * 1024,
                  hashAlgorithm: "sha1",
                  concurrency: 1,
                  compression: [],
                }),
              );
            } else if (
              request.url ===
              "/api/0/projects/test-org/test-project/files/preprodartifacts/assemble/"
            ) {
              const data = JSON.parse(body.toString("utf8")) as {
                chunks: string[];
              };
              response.end(
                JSON.stringify(
                  uploaded.length
                    ? {
                        state: "ok",
                        artifactUrl: `${fixtureState.origin}/artifacts/1`,
                      }
                    : { state: "not_found", missingChunks: data.chunks },
                ),
              );
            } else if (request.url === "/chunks/") {
              const form = await new Response(body, {
                headers: {
                  "Content-Type": request.headers["content-type"] ?? "",
                },
              }).formData();
              for (const file of form.getAll("file")) {
                if (typeof file !== "string") {
                  uploaded.push(new Uint8Array(await file.arrayBuffer()));
                }
              }
              response.end("{}");
            } else {
              unexpected.push(request.url ?? "");
              response.statusCode = 404;
              response.end('{"detail":"Unexpected fixture request"}');
            }
          } catch {
            fixtureState.errors += 1;
            response.statusCode = 500;
            response.end('{"detail":"Fixture server failed"}');
          }
        });
        try {
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
          });
          const address = server.address();
          if (!address || typeof address === "string") {
            throw new Error("Missing fixture server address");
          }
          fixtureState.origin = `http://127.0.0.1:${address.port}`;
          const home = join(state.directory, `binary-home-${idiom}`);
          await mkdir(home);
          const result = await run(
            binary,
            [
              "build",
              "upload",
              source,
              "--org",
              "test-org",
              "--project",
              "test-project",
              "--no-git-metadata",
              "--json",
            ],
            {
              timeout: 120_000,
              env: {
                PATH: process.env.PATH,
                HOME: home,
                XDG_CONFIG_HOME: join(home, "config"),
                SENTRY_CONFIG_DIR: join(home, "sentry"),
                SENTRY_URL: fixtureState.origin,
                SENTRY_AUTH_TOKEN: "synthetic-local-test-token",
                SENTRY_FORCE_ENV_TOKEN: "1",
                SENTRY_CLI_NO_TELEMETRY: "1",
                SENTRY_CLI_NO_UPDATE_CHECK: "1",
                CI: "1",
                NO_COLOR: "1",
              },
            },
          );
          expect(result.stdout).toContain(`${fixtureState.origin}/artifacts/1`);
          expect(unexpected).toEqual([]);
          expect(fixtureState.errors).toBe(0);
          expect(uploaded).toHaveLength(1);
          const bytes = uploaded[0];
          if (!bytes) {
            throw new Error("Binary did not upload a build chunk");
          }
          assertParsedAssets(unzipSync(bytes), basename(source), idiom);
        } finally {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        }
      },
      150_000,
    );
  },
);
