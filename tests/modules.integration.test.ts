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

test("a handler from another file brings the helpers it calls with it", async () => {
  const result = await build({
    "src/util.ts": `
      export const shout = (value: string) => value.toUpperCase();
      export const wrap = (value: string) => ({ said: shout(value) });
    `,
    "src/handlers.ts": `
      import { wrap } from "./util.ts";
      const greeting = "hi";
      export const hello = () => wrap(greeting);
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { hello } from "./handlers.ts";
      const app = orvox();
      app.get("/hello", hello);
      export default app;
    `,
  });

  const server = await serve(result);
  try {
    // shout is two hops away: hello -> wrap -> shout, across two files
    expect(await (await fetch(new URL("/hello", server.url))).json()).toEqual({ said: "HI" });
  } finally {
    await server.stop(true);
    delete process.env.PORT;
  }
});

test("middleware from another file keeps its template literals intact", async () => {
  const result = await build({
    "src/mw.ts": `
      import { guard } from "@orvox/core";
      export const key = guard(({ headers }) =>
        headers.authorization === \`Bearer \${process.env.K ?? "dev"}\`
          ? undefined
          : new Response("Unauthorized", { status: 401 }));
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { key } from "./mw.ts";
      const app = orvox();
      app.get("/a", { use: [key], handler: () => "ok" });
      export default app;
    `,
  });

  // printed against the wrong file, the template literal used to be spliced
  // together from whatever characters sat at those offsets in the entry
  expect(result.code).toContain('`Bearer ${process.env.K ?? "dev"}`');

  const server = await serve(result);
  try {
    expect((await fetch(new URL("/a", server.url))).status).toBe(401);
    expect((await fetch(new URL("/a", server.url), {
      headers: { authorization: "Bearer dev" },
    })).status).toBe(200);
  } finally {
    await server.stop(true);
    delete process.env.PORT;
  }
});

test("drops an import once nothing that survives still names it", async () => {
  const result = await build({
    "src/schemas.ts": `
      import { t } from "@orvox/core";
      export const A = t.object({ n: t.int() });
      export const B = t.object({ s: t.string() });
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { A, B } from "./schemas.ts";
      const app = orvox();
      app.post("/a", { body: A, handler: ({ body }) => body });
      app.post("/b", { body: B, handler: ({ body }) => body });
      export default app;
    `,
  });

  // both compiled into checks, so the file that gets deployed imports nothing
  // (import.meta.main is not an import statement)
  expect(result.code.match(/^import .*/gm)).toBeNull();
});

test("narrows an import to the names that survive", async () => {
  const result = await build({
    "src/schemas.ts": `
      import { t, type Infer } from "@orvox/core";
      export const A = t.object({ n: t.int() });
      export type A = Infer<typeof A>;
      export const label = "kept";
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { A, label } from "./schemas.ts";
      const app = orvox();
      app.post("/a", { body: A, handler: ({ body }) => ({ n: body.n, label }) });
      export default app;
    `,
  });

  // label is used by the handler and stays; A was compiled into checks and goes.
  // A retained import also carries its own module's dependencies, which is why
  // dropping the ones nothing needs is worth doing.
  const imports = result.code.match(/^import .*/gm) ?? [];
  expect(imports).toHaveLength(1);
  expect(imports[0]).toContain("{ label }");
  expect(imports[0]).not.toContain("A");
});

test("expands Infer<typeof X> so the schema it names can still be erased", async () => {
  const result = await build({
    "src/schemas.ts": `
      import { t, type Infer } from "@orvox/core";
      export const CreateUser = t.object({
        name: t.string({ min: 1 }),
        role: t.enum(["admin", "member"]),
        tags: t.optional(t.array(t.string())),
      });
      export type CreateUser = Infer<typeof CreateUser>;
    `,
    "src/app.ts": `
      import { orvox } from "@orvox/core";
      import { CreateUser } from "./schemas.ts";
      const app = orvox();
      const seen: CreateUser[] = [];
      app.post("/users", {
        body: CreateUser,
        handler: ({ body }) => { seen.push(body); return { count: seen.length, role: body.role }; },
      });
      export default app;
    `,
  });

  // the type survives, spelled out; the schema and its import do not
  const flat = result.code.replace(/\s+/g, " ");
  expect(flat).toContain("name: string");
  expect(flat).toContain('role: "admin" | "member"');
  expect(flat).toContain("tags?: string[]");
  expect(result.code).not.toContain("Infer<");
  expect(result.code).not.toContain("t.object(");
  expect(result.code.match(/^import .*/gm)).toBeNull();

  const server = await serve(result);
  try {
    const r = await fetch(new URL("/users", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "amp", role: "admin" }),
    });
    expect(await r.json()).toEqual({ count: 1, role: "admin" });
  } finally {
    await server.stop(true);
    delete process.env.PORT;
  }
});

test("expands an Infer used inside a larger type", async () => {
  const result = await build({
    "src/app.ts": `
      import { orvox, t, type Infer } from "@orvox/core";
      const app = orvox();
      const Create = t.object({ name: t.string() });
      type User = Infer<typeof Create> & { id: string };
      const store: User[] = [];
      app.post("/users", {
        body: Create,
        handler: ({ body }) => { store.push({ ...body, id: "1" }); return store[0]!; },
      });
      export default app;
    `,
  });

  const flat = result.code.replace(/\s+/g, " ");
  expect(flat).toContain("type User = { name: string } & { id: string; };");
  expect(result.code).not.toContain("Infer<");
  expect(result.code).not.toContain("t.object(");
});
