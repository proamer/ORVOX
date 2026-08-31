import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, compileSource } from "@orvox/compiler";

const source = `
  import { orvox } from "@orvox/core"
  let requests = 0
  const app = orvox({ maxRequestBodySize: 64 })
  app.onRequest(() => { requests++ })
  app.get("/count", () => ({ requests }))
  app.get("/boom", () => { throw new Error("do-not-leak") })
  app.post("/body", ({ body }) => body)
  export default app
`;

describe("production runtime defaults", () => {
  let server: Bun.Server<unknown>;
  let baseUrl: URL;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "orvox-m5-prod-"));
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, source, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    process.env.PORT = "0";
    ({ server } = await import(`${pathToFileURL(output.serverPath).href}?prod=${Date.now()}`));
    baseUrl = server.url;
  });

  afterAll(async () => {
    await server?.stop(true);
    delete process.env.PORT;
    await rm(directory, { recursive: true, force: true });
  });

  test("runs the opt-in request hook on matched native routes", async () => {
    const first = await fetch(new URL("/count", baseUrl));
    const second = await fetch(new URL("/count", baseUrl));
    expect(await first.json()).toEqual({ requests: 1 });
    expect(await second.json()).toEqual({ requests: 2 });
  });

  test("returns a bounded 500 without leaking thrown details", async () => {
    const response = await fetch(new URL("/boom", baseUrl));
    expect([response.status, await response.text()]).toEqual([500, "Internal Server Error"]);
  });

  test("enforces the configured Bun request-body limit", async () => {
    const response = await fetch(new URL("/body", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(256) }),
    });
    expect(response.status).toBe(413);
  });
});

test("custom error hooks replace the safe default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvox-m5-error-"));
  let server: Bun.Server<unknown> | undefined;
  try {
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, `
      import { orvox } from "@orvox/core"
      const app = orvox()
      app.onError(error => Response.json({ code: "FAILED", message: error.message }, { status: 503 }))
      app.get("/boom", () => { throw new Error("handled") })
      export default app
    `, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    process.env.PORT = "0";
    ({ server } = await import(`${pathToFileURL(output.serverPath).href}?error=${Date.now()}`));
    const response = await fetch(new URL("/boom", server!.url));
    expect([response.status, await response.json()]).toEqual([503, { code: "FAILED", message: "handled" }]);
  } finally {
    await server?.stop(true);
    delete process.env.PORT;
    await rm(directory, { recursive: true, force: true });
  }
});

test("main process runs the stop hook before graceful shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "orvox-m5-stop-"));
  try {
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, `
      import { orvox } from "@orvox/core"
      const app = orvox()
      app.onStop(() => console.log("STOP_HOOK_RAN"))
      app.get("/", () => "ok")
      if (import.meta.main) setTimeout(() => process.emit("SIGTERM"), 25)
      export default app
    `, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    const child = Bun.spawn([process.execPath, output.serverPath], {
      cwd: directory,
      env: { ...process.env, PORT: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    await child.exited;
    expect(await new Response(child.stdout).text()).toContain("STOP_HOOK_RAN");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("emits deterministic OpenAPI and writes the artifact", async () => {
  const apiSource = `
    import { orvox, t } from "@orvox/core"
    const Input = t.object({ name: t.string({ min: 1 }), age: t.optional(t.int({ min: 0 })) })
    const app = orvox()
    app.post("/users/:id", { body: Input, handler: ({ params, body }) => ({ id: params.id, ...body }) })
    export default app
  `;
  const result = compileSource(apiSource, { entryPath: "src/app.ts" });
  expect(result.openapi).toEqual({
    openapi: "3.1.0",
    info: { title: "ORVOX API", version: "0.0.0" },
    paths: {
      "/users/{id}": {
        post: {
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string", minLength: 1 },
                    age: { type: "integer", minimum: 0 },
                  },
                  additionalProperties: false,
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            "200": { description: "Successful response" },
            "400": { description: "Validation failed" },
          },
        },
      },
    },
  });

  const configured = compileSource(`
    import { orvox } from "@orvox/core"
    const app = orvox({ openapi: { title: "Billing", version: "2.4.0" } })
    app.get("/invoices", () => [])
    export default app
  `, { entryPath: "src/app.ts" });
  expect(configured.openapi.info).toEqual({ title: "Billing", version: "2.4.0" });

  expect(() => compileSource(`
    import { orvox } from "@orvox/core"
    const version = "9"
    const app = orvox({ openapi: { version } })
    app.get("/", () => "ok")
    export default app
  `, { entryPath: "src/app.ts" })).toThrow("openapi.version must be a non-empty string literal.");

  expect(() => compileSource(`
    import { orvox } from "@orvox/core"
    const app = orvox({ openapi: { descriptio: "typo" } })
    app.get("/", () => "ok")
    export default app
  `, { entryPath: "src/app.ts" })).toThrow("openapi accepts only title and version.");

  const directory = await mkdtemp(join(tmpdir(), "orvox-m5-openapi-"));
  try {
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, apiSource, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    expect(output.openapiPath).toBe(join(directory, ".orvox", "openapi.json"));
    expect(JSON.parse(await readFile(output.openapiPath, "utf8"))).toEqual(result.openapi);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
