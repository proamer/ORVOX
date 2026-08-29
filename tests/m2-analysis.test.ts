import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, compileSource } from "@orvox/compiler";

const source = `
  import { orvox } from "@orvox/core"
  const app = orvox()
  app.post("/body", ({ body }) => body)
  app.get("/query", ({ query }) => query)
  app.get("/headers", ({ headers }) => ({
    authorization: headers.authorization,
    key: headers["x-api-key"]
  }))
  app.get("/cookies", ({ cookies }) => ({ session: cookies.get("session") }))
  app.get("/request", ({ request }) => request.method)
  app.get("/server", ({ server }) => ({ active: server.port > 0 }))
  app.get("/identifier", ctx => ({ limit: ctx.query.limit }))
  export default app
`;

const needs = (overrides: Partial<{
  body: boolean;
  query: boolean;
  headers: string[] | false;
  cookies: boolean;
  server: boolean;
  rawRequest: boolean;
}>) => ({
  body: false,
  query: false,
  headers: false as string[] | false,
  cookies: false,
  server: false,
  rawRequest: false,
  ...overrides,
});

test("usage analysis records only request data each route reads", () => {
  const result = compileSource(source, { entryPath: "src/app.ts" });

  expect(result.manifest.routes.map(route => [route.path, route.needs])).toEqual([
    ["/body", needs({ body: true })],
    ["/query", needs({ query: true })],
    ["/headers", needs({ headers: ["authorization", "x-api-key"] })],
    ["/cookies", needs({ cookies: true })],
    ["/request", needs({ rawRequest: true })],
    ["/server", needs({ server: true })],
    ["/identifier", needs({ query: true })],
  ]);
  expect(result.analysis.warnings).toEqual([]);
});

describe("generated M2 request bindings", () => {
  let server: Bun.Server<unknown>;
  let baseUrl: URL;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "orvox-m2-"));
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, source, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    process.env.PORT = "0";
    ({ server } = await import(`${pathToFileURL(output.serverPath).href}?m2=${Date.now()}`));
    baseUrl = server.url;
  });

  afterAll(async () => {
    await server?.stop(true);
    delete process.env.PORT;
    await rm(directory, { recursive: true, force: true });
  });

  test("materializes body, query, selected headers, cookies, request, and server", async () => {
    const body = await fetch(new URL("/body", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Amp" }),
    });
    const query = await fetch(new URL("/query?limit=10&sort=asc", baseUrl));
    const headers = await fetch(new URL("/headers", baseUrl), {
      headers: {
        authorization: "Bearer test",
        "x-api-key": "secret",
        "x-unused": "must-not-materialize",
      },
    });
    const cookies = await fetch(new URL("/cookies", baseUrl), {
      headers: { cookie: "session=abc" },
    });
    const request = await fetch(new URL("/request", baseUrl));
    const serverResult = await fetch(new URL("/server", baseUrl));
    const identifier = await fetch(new URL("/identifier?limit=25", baseUrl));

    expect(await body.json()).toEqual({ name: "Amp" });
    expect(await query.json()).toEqual({ limit: "10", sort: "asc" });
    expect(await headers.json()).toEqual({
      authorization: "Bearer test",
      key: "secret",
    });
    expect(await cookies.json()).toEqual({ session: "abc" });
    expect(await request.text()).toBe("GET");
    expect(await serverResult.json()).toEqual({ active: true });
    expect(await identifier.json()).toEqual({ limit: "25" });
  });
});

