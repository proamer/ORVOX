import { afterAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = join(import.meta.dir, "..");
const pnpm = Bun.which("pnpm")!;
const artifacts = join(root, "artifacts");

afterAll(async () => {
  await rm(artifacts, { recursive: true, force: true });
});

test("packs alpha packages and runs CRUD from a clean install", async () => {
  const pack = Bun.spawn([process.execPath, join(root, "scripts", "pack-alpha.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [packCode, packError] = await Promise.all([
    pack.exited,
    new Response(pack.stderr).text(),
  ]);
  expect(packCode, packError).toBe(0);

  const names = ["schema", "core", "compiler", "cli"];
  const tarballs = Object.fromEntries(names.map(name => [
    name,
    join(artifacts, `orvox-${name}-0.1.0-alpha.0.tgz`),
  ]));
  for (const tarball of Object.values(tarballs)) {
    expect((await Bun.file(tarball).exists())).toBe(true);
  }

  const directory = await mkdtemp(join(tmpdir(), "orvox-alpha-"));
  let server: Bun.Server<unknown> | undefined;
  try {
    const fileDependency = (path: string) => `file:${path.replaceAll("\\", "/")}`;
    const packedDependencies = {
      "@orvox/schema": fileDependency(tarballs.schema),
      "@orvox/core": fileDependency(tarballs.core),
      "@orvox/compiler": fileDependency(tarballs.compiler),
      "@orvox/cli": fileDependency(tarballs.cli),
    };
    await writeFile(join(directory, "package.json"), JSON.stringify({
      name: "orvox-alpha-smoke",
      private: true,
      type: "module",
      dependencies: packedDependencies,
    }, null, 2));
    await writeFile(
      join(directory, "pnpm-workspace.yaml"),
      `packages: []\noverrides:\n${Object.entries(packedDependencies)
        .map(([name, value]) => `  '${name}': '${value}'`)
        .join("\n")}\n`,
    );
    await mkdir(join(directory, "src"));
    await copyFile(join(root, "examples", "crud", "src", "app.ts"), join(directory, "src", "app.ts"));

    const install = Bun.spawn([pnpm, "install", "--offline", "--ignore-scripts"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [installCode, installOutput, installError] = await Promise.all([
      install.exited,
      new Response(install.stdout).text(),
      new Response(install.stderr).text(),
    ]);
    if (installCode !== 0) throw new Error(`${installOutput}\n${installError}`.trim());

    const build = Bun.spawn([pnpm, "exec", "orvox", "build", "src/app.ts"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [buildCode, buildOutput, buildError] = await Promise.all([
      build.exited,
      new Response(build.stdout).text(),
      new Response(build.stderr).text(),
    ]);
    if (buildCode !== 0) throw new Error(`${buildOutput}\n${buildError}`.trim());

    process.env.PORT = "0";
    ({ server } = await import(`${pathToFileURL(join(directory, ".orvox", "server.generated.ts")).href}?alpha=${Date.now()}`));
    const created = await fetch(new URL("/users", server!.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Amp", age: 35 }),
    });
    const user = await created.json() as { id: string; name: string; age: number };
    expect(created.status).toBe(201);

    const read = await fetch(new URL(`/users/${user.id}`, server!.url));
    expect(await read.json()).toEqual(user);

    const updated = await fetch(new URL(`/users/${user.id}`, server!.url), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "AMP" }),
    });
    expect((await updated.json()).name).toBe("AMP");

    const removed = await fetch(new URL(`/users/${user.id}`, server!.url), { method: "DELETE" });
    expect(removed.status).toBe(204);
  } finally {
    await server?.stop(true);
    delete process.env.PORT;
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

describe("benchmark report", () => {
  test("writes median and spread Markdown from raw oha results", async () => {
    const directory = await mkdtemp(join(tmpdir(), "orvox-report-"));
    try {
      const input = join(directory, "raw.json");
      const output = join(directory, "summary.md");
      await writeFile(input, JSON.stringify({
        results: [100, 140, 110].map((requestsPerSec, index) => ({
          workload: "B01",
          framework: "orvox",
          iteration: index + 1,
          measurement: { summary: { requestsPerSec } },
        })),
      }));
      const child = Bun.spawn([
        process.execPath,
        join(root, "scripts", "report-benchmark.ts"),
        input,
        "--output",
        output,
      ], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(await child.exited).toBe(0);
      expect(await readFile(output, "utf8")).toContain("| B01 | orvox | 110.00 | 36.36% |");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
