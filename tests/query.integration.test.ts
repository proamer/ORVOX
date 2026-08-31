import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, compileSource } from "@orvox/compiler";

// Query values arrive as strings, so a declared t.int() can only mean "parse
// this as an integer". Bodies are JSON and keep their own types, so the same
// builder must NOT coerce there -- position decides, see the 0.2.0 notes.
const source = `
  import { orvox, t } from "@orvox/core"

  const Search = t.object({
    q: t.string({ min: 1 }),
    page: t.optional(t.int({ min: 1, max: 100 })),
    exact: t.optional(t.boolean()),
  })

  const app = orvox()
  app.get("/search", { query: Search, handler: ({ query }) => query })
  export default app
`;

let server: Bun.Server<unknown>;
let baseUrl: URL;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "orvox-query-"));
  const entryPath = join(directory, "app.ts");
  await writeFile(entryPath, source, "utf8");
  const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
  process.env.PORT = "0";
  ({ server } = await import(`${pathToFileURL(output.serverPath).href}?query=${Date.now()}`));
  baseUrl = server.url;
});

afterAll(async () => {
  await server?.stop(true);
  delete process.env.PORT;
  await rm(directory, { recursive: true, force: true });
});

const get = (search: string) => fetch(new URL(`/search${search}`, baseUrl));

test("coerces declared query values to their schema types", async () => {
  const response = await get("?q=bun&page=3&exact=true");
  expect(await response.json()).toEqual({ q: "bun", page: 3, exact: true });
});

test("omits absent optionals rather than passing undefined strings", async () => {
  expect(await (await get("?q=bun")).json()).toEqual({ q: "bun" });
});

test("rejects a value that is not an integer", async () => {
  const response = await get("?q=bun&page=two");
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({
    error: "VALIDATION_FAILED",
    issues: [{ path: "$.page", code: "invalid_type", message: "Expected an integer." }],
  });
});

test("enforces bounds after coercion", async () => {
  const response = await get("?q=bun&page=0");
  expect((await response.json()).issues[0]).toEqual({
    path: "$.page",
    code: "min_value",
    message: "Expected a value greater than or equal to 1.",
  });
});

test("reports a missing required parameter", async () => {
  const response = await get("");
  expect(response.status).toBe(400);
  expect((await response.json()).issues[0].code).toBe("required");
});

test("ignores undeclared query parameters", async () => {
  const response = await get("?q=bun&utm_source=newsletter");
  expect(await response.json()).toEqual({ q: "bun" });
});

test("only accepts true and false for booleans", async () => {
  expect((await (await get("?q=bun&exact=yes")).json()).issues[0]).toEqual({
    path: "$.exact",
    code: "invalid_type",
    message: "Expected true or false.",
  });
});

test("a body schema still refuses a string where an integer is declared", () => {
  const result = compileSource(`
    import { orvox, t } from "@orvox/core"
    const app = orvox()
    app.post("/x", { body: t.object({ n: t.int() }), handler: ({ body }) => body })
    export default app
  `, { entryPath: "src/app.ts" });
  // no Number() anywhere near the body path -- coercion is query-only
  expect(result.code).not.toContain("Number(__orvoxBody");
});
