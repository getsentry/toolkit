/**
 * Shader manifest lookup for DXIL shader binaries.
 *
 * An Unreal cook exports one `.dxil` file per compiled shader. The GPU crash
 * decoder identifies a shader by NVIDIA's own hash of its bytes, which only
 * NVIDIA's Windows library can compute, so the Sentry Unreal plugin computes it
 * at cook time and writes `sentry-shader-manifest.tsv` next to the files. Each
 * row is `<aftermath hash>\t<pdb name>\t<dxil path>[\t<shader group>]`; the
 * hash is sent as the file's `code_id` and the group as `shader_group`.
 */

import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { logger } from "../logger.js";

const log = logger.withTag("dif.shader-manifest");

/** File name of the manifest the Unreal plugin writes next to the shaders. */
export const SHADER_MANIFEST_FILE_NAME = "sentry-shader-manifest.tsv";

/** Largest value of a 64-bit shader hash. */
const MAX_U64 = 0xffffffffffffffffn;

/** Manifest metadata of a single `.dxil` file. */
export type ShaderInfo = {
  /** NVIDIA Aftermath shader hash as 16 lowercase hex digits. */
  codeId: string;
  /** Engine shader group, e.g. `Global/FHeavyComputeLoop/0`, when recorded. */
  shaderGroup?: string;
};

/** `.dxil` file names mapped to their manifest metadata. */
export type ShaderManifest = ReadonlyMap<string, ShaderInfo>;

/**
 * Parse manifest contents. Rows with a missing or non-numeric hash or a missing
 * path are skipped; a blank group column means no group.
 */
export function parseShaderManifest(contents: string): ShaderManifest {
  const manifest = new Map<string, ShaderInfo>();
  for (const line of contents.split("\n")) {
    const [hashColumn, , pathColumn, groupColumn] = line.split("\t");
    if (!(hashColumn && pathColumn)) {
      continue;
    }
    const hashText = hashColumn.trim();
    if (!/^\d+$/.test(hashText)) {
      continue;
    }
    const hash = BigInt(hashText);
    if (hash > MAX_U64) {
      continue;
    }
    const fileName = pathColumn.trim().split(/[\\/]/).pop();
    if (!fileName) {
      continue;
    }
    const shaderGroup = groupColumn?.trim();
    manifest.set(fileName, {
      codeId: hash.toString(16).padStart(16, "0"),
      ...(shaderGroup ? { shaderGroup } : {}),
    });
  }
  return manifest;
}

/**
 * Load the manifest written next to the shader files in `dir`. A missing or
 * unreadable manifest yields an empty map: the binaries are then uploaded
 * without a code id, which is still a valid debug file.
 */
export async function loadShaderManifest(dir: string): Promise<ShaderManifest> {
  const path = join(dir, SHADER_MANIFEST_FILE_NAME);
  try {
    return parseShaderManifest(await readFile(path, "utf8"));
  } catch (err) {
    log.debug(
      `No shader manifest at ${path}; DXIL files are uploaded without code id`,
      err,
    );
    return new Map();
  }
}

/** Per-directory manifest cache for one scan. */
export class ShaderManifestCache {
  private readonly manifests = new Map<string, Promise<ShaderManifest>>();

  /** The manifest entry for the `.dxil` file at `path`, if any. */
  async lookup(path: string): Promise<ShaderInfo | undefined> {
    const dir = dirname(path);
    let manifest = this.manifests.get(dir);
    if (!manifest) {
      manifest = loadShaderManifest(dir);
      this.manifests.set(dir, manifest);
    }
    return (await manifest).get(basename(path));
  }
}
