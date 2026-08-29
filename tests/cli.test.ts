import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("build command writes all inspectable compiler artifacts", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "orvox-cli-"));
  try {
    const entryPath = join(tempDir, "app.ts");
    const outDir = join(tempDir, "generated");
    await writeFile(
      entryPath,
      `
        import { orvox } from "@orvox/core"
        const app = orvox()
        app.get("/", () => "cli")
        export default app
      `,
      "utf8",
    );

    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "..", "packages", "cli", "src", "index.ts"),
        "build",
        entryPath,
        "--outdir",
        outDir,
      ],
      { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
    );

    expect(await child.exited).toBe(0);
    expect(await new Response(child.stdout).text()).toContain(
      "Built 1 route",
    );
    expect(await readFile(join(outDir, "server.generated.ts"), "utf8")).toContain(
      'GET: new Response("cli")',
    );
    expect(
      JSON.parse(await readFile(join(outDir, "routes.manifest.json"), "utf8"))
        .routes,
    ).toHaveLength(1);
    expect(
      JSON.parse(await readFile(join(outDir, "analysis.json"), "utf8"))
        .warnings,
    ).toEqual([]);
    expect(
      JSON.parse(await readFile(join(outDir, "openapi.json"), "utf8"))
        .openapi,
    ).toBe("3.1.0");
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("unknown commands fail with actionable usage", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "packages", "cli", "src", "index.ts"),
      "wat",
    ],
    { cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "pipe" },
  );

  expect(await child.exited).toBe(1);
  expect(await new Response(child.stderr).text()).toContain(
    "Usage: orvox <build|inspect|dev>",
  );
});
