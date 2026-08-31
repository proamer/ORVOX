import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "@orvox/compiler";

let directory: string | undefined;

afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

/** Writes a small project and compiles its entry, returning the result. */
const build = async (files: Record<string, string>) => {
  directory = await mkdtemp(join(tmpdir(), "orvox-modules-"));
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents, "utf8");
  }
  return compile(join(directory, "src/app.ts"), { outDir: join(directory, ".orvox") });
};

const serve = async (result: Awaited<ReturnType<typeof compile>>) => {
  process.env.PORT = "0";
  const { server } = await import(`${pathToFileURL(result.serverPath).href}?m=${Date.now()}`);
  return server as Bun.Server<unknown>;
};

test("a schema imported from another file compiles into the checks", async () => {
  const result = await build({
    "src/schemas.ts": `
      import { t } from "@orvox/core";
      export const CreateUser = t.object({ name: t.string({ min: 2 }), age: t.int({ min: 0 }) });
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { CreateUser } from "./schemas.ts";
      const app = orvox();
      app.post("/users", { body: CreateUser, handler: ({ body }) => body });
      export default app;
    `,
  });

  // consumed at build time: no schema construction survives, and nothing is imported for it
  expect(result.code).not.toContain("t.object(");
  expect(result.code).not.toContain("./schemas");

  const server = await serve(result);
  try {
    const bad = await fetch(new URL("/users", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "a", age: 1 }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).issues[0]).toEqual({
      path: "$.name",
      code: "min_length",
      message: "Expected at least 2 characters.",
    });
  } finally {
    await server.stop(true);
    delete process.env.PORT;
  }
});

test("a schema that references another declaration in its own file", async () => {
  const result = await build({
    "src/schemas.ts": `
      import { t } from "@orvox/core";
      const Name = t.string({ min: 2 });
      export const CreateUser = t.object({ name: Name });
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { CreateUser } from "./schemas.ts";
      const app = orvox();
      app.post("/users", { body: CreateUser, handler: ({ body }) => body });
      export default app;
    `,
  });
  expect(result.manifest.routes[0]!.schema).toEqual({
    kind: "object",
    properties: [{ name: "name", required: true, schema: { kind: "string", min: 2 } }],
  });
});

test("middleware imported from another file", async () => {
  const result = await build({
    "src/mw.ts": `
      import { header } from "@orvox/core";
      export const branding = header("x-app", "probe");
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { branding } from "./mw.ts";
      const app = orvox();
      app.use(branding);
      app.get("/a", () => "x");
      export default app;
    `,
  });
  expect(result.manifest.routes[0]!.middleware).toEqual([
    { kind: "header", name: "x-app", value: "probe" },
  ]);
  expect(result.code).not.toContain("./mw");
});

test("a handler declared as a top-level const in the entry file", async () => {
  const result = await build({
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      const app = orvox();
      const listUsers = () => ["a", "b"];
      app.get("/users", listUsers);
      export default app;
    `,
  });
  const server = await serve(result);
  try {
    expect(await (await fetch(new URL("/users", server.url))).json()).toEqual(["a", "b"]);
  } finally {
    await server.stop(true);
    delete process.env.PORT;
  }
});

test("a chain of imports resolves through every hop", async () => {
  const result = await build({
    "src/primitives.ts": `
      import { t } from "@orvox/core";
      export const Name = t.string({ min: 3 });
    `,
    "src/schemas.ts": `
      import { t } from "@orvox/core";
      import { Name } from "./primitives.ts";
      export const CreateUser = t.object({ name: Name });
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { CreateUser } from "./schemas.ts";
      const app = orvox();
      app.post("/users", { body: CreateUser, handler: ({ body }) => body });
      export default app;
    `,
  });
  expect(result.manifest.routes[0]!.schema).toEqual({
    kind: "object",
    properties: [{ name: "name", required: true, schema: { kind: "string", min: 3 } }],
  });
});

test("an import that cannot be resolved says so, naming the file", async () => {
  await expect(build({
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { Missing } from "./nope.ts";
      const app = orvox();
      app.post("/a", { body: Missing, handler: ({ body }) => body });
      export default app;
    `,
  })).rejects.toThrow(/nope\.ts/);
});
