import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, compileSource } from "@orvox/compiler";

const source = `
  import { orvox, t } from "@orvox/core"
  const app = orvox()
  app.get("/users/:id/posts/:slug", {
    params: t.object({ id: t.int({ min: 1 }), slug: t.string({ min: 3 }) }),
    handler: ({ params }) => params,
  })
  export default app
`;

let server: Bun.Server<unknown>;
let baseUrl: URL;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "orvox-params-"));
  const entryPath = join(directory, "app.ts");
  await writeFile(entryPath, source, "utf8");
  const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
  process.env.PORT = "0";
  ({ server } = await import(`${pathToFileURL(output.serverPath).href}?params=${Date.now()}`));
  baseUrl = server.url;
});

afterAll(async () => {
  await server?.stop(true);
  delete process.env.PORT;
  await rm(directory, { recursive: true, force: true });
});

test("converts a declared path param to its schema type", async () => {
  const response = await fetch(new URL("/users/42/posts/hello", baseUrl));
  expect(await response.json()).toEqual({ id: 42, slug: "hello" });
});

test("rejects a param that is not an integer", async () => {
  const response = await fetch(new URL("/users/abc/posts/hello", baseUrl));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "VALIDATION_FAILED",
    issues: [{ path: "$.id", code: "invalid_type", message: "Expected an integer." }],
  });
});

test("enforces bounds on a converted param", async () => {
  const response = await fetch(new URL("/users/0/posts/hello", baseUrl));
  expect((await response.json()).issues[0].code).toBe("min_value");
});

test("enforces bounds on a string param", async () => {
  const response = await fetch(new URL("/users/1/posts/ab", baseUrl));
  expect((await response.json()).issues[0]).toEqual({
    path: "$.slug",
    code: "min_length",
    message: "Expected at least 3 characters.",
  });
});

const build = (body: string) => () => compileSource(`
  import { orvox, t } from "@orvox/core"
  const app = orvox()
  ${body}
  export default app
`, { entryPath: "src/app.ts" });

test("refuses a params schema naming something the path does not declare", () => {
  expect(build(`
    app.get("/users/:id", { params: t.object({ nope: t.string() }), handler: ({ params }) => params })
  `)).toThrow('Path "/users/:id" declares no param "nope".');
});

test("refuses an optional path param, since a matched route always has one", () => {
  expect(build(`
    app.get("/users/:id", { params: t.object({ id: t.optional(t.int()) }), handler: ({ params }) => params })
  `)).toThrow('Path param "id" cannot be optional.');
});
