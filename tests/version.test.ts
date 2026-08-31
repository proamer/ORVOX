import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { version } from "../package.json" with { type: "json" };

// Compiler, CLI, and pack script all read the version from a package.json now.
// The docs cannot -- they are prose -- so this is what stops them drifting.
const root = join(import.meta.dir, "..");

const stated = async (file: string, pattern: RegExp) => {
  const text = await readFile(join(root, file), "utf8");
  return text.match(pattern)?.[1];
};

test("every workspace package is on the root version", async () => {
  const packages = ["schema", "core", "compiler", "cli"];
  const versions = await Promise.all(packages.map(async name => {
    const manifest = await readFile(join(root, "packages", name, "package.json"), "utf8");
    return [name, JSON.parse(manifest).version] as const;
  }));
  expect(Object.fromEntries(versions)).toEqual(
    Object.fromEntries(packages.map(name => [name, version])),
  );
});

test("the README states the current version", async () => {
  expect(await stated("README.md", /<code>(\d+\.\d+\.\d+[^<]*)<\/code> · MIT/)).toBe(version);
});

test("the handbook states the current version", async () => {
  const page = "docs/index.html";
  expect(await stated(page, /class="chip chip-src">([^<]+)</)).toBe(version);
  expect(await stated(page, /ORVOX (\d+\.\d+\.\d+[^ ]*) · MIT/)).toBe(version);
});
