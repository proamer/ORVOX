import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "@orvox/compiler";

let server: Bun.Server<unknown>;
let baseUrl: URL;
let tempDir: string;

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "orvox-integration-"));
  const entryPath = join(tempDir, "app.ts");
  await writeFile(
    entryPath,
    `
      import { orvox } from "@orvox/core"
      const app = orvox(), greeting = "hello"
      app.get("/", () => greeting)
      app.get("/json", () => ({ ok: true }))
      app.get("/dynamic", () => ({ now: Date.now() }))
      app.get("/users/:id", ({ params }) => ({ id: params.id }))
      app.post("/users/:id", ({ params }) => ({ created: params.id }))
      app.post("/users/me", () => ({ special: true }))
      app.raw("GET", "/native/:id", req => new Response(req.params.id))
      export default app
    `,
    "utf8",
  );

  const output = await compile(entryPath, { outDir: join(tempDir, ".orvox") });
  process.env.PORT = "0";
  const generated = await import(
    `${pathToFileURL(output.serverPath).href}?test=${Date.now()}`
  );
  server = generated.server;
  baseUrl = server.url;
});

afterAll(async () => {
  await server?.stop(true);
  delete process.env.PORT;
  await rm(tempDir, { recursive: true, force: true });
});

describe("generated server", () => {
  test("serves a static response repeatedly without consuming its body", async () => {
    const first = await fetch(new URL("/", baseUrl));
    const second = await fetch(new URL("/", baseUrl));

    expect([first.status, await first.text()]).toEqual([200, "hello"]);
    expect([second.status, await second.text()]).toEqual([200, "hello"]);
    expect(first.headers.get("content-type")).toStartWith("text/plain");
  });

  test("specializes JSON and native parameter responses", async () => {
    const json = await fetch(new URL("/json", baseUrl));
    const dynamic = await fetch(new URL("/dynamic", baseUrl));
    const param = await fetch(new URL("/users/a%20b", baseUrl));
    const raw = await fetch(new URL("/native/42", baseUrl));

    expect(await json.json()).toEqual({ ok: true });
    expect(json.headers.get("content-type")).toStartWith("application/json");
    expect(typeof (await dynamic.json()).now).toBe("number");
    expect(await param.json()).toEqual({ id: "a b" });
    expect(await raw.text()).toBe("42");
  });

  test("keeps handlers separated by HTTP method", async () => {
    const post = await fetch(new URL("/users/7", baseUrl), { method: "POST" });
    const unsupported = await fetch(new URL("/users/7", baseUrl), {
      method: "PUT",
    });
    const options = await fetch(new URL("/users/7", baseUrl), {
      method: "OPTIONS",
    });
    const exact = await fetch(new URL("/users/me", baseUrl), { method: "POST" });
    const exactUnsupported = await fetch(new URL("/users/me", baseUrl), {
      method: "PUT",
    });

    expect(await post.json()).toEqual({ created: "7" });
    expect(unsupported.status).toBe(405);
    expect(unsupported.headers.get("allow")).toBe(
      "GET, HEAD, POST, OPTIONS",
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("allow")).toBe("GET, HEAD, POST, OPTIONS");
    expect(await exact.json()).toEqual({ special: true });
    expect(exactUnsupported.status).toBe(405);
    expect(exactUnsupported.headers.get("allow")).toBe("POST, OPTIONS");
  });

  test("preserves HEAD and 404 semantics", async () => {
    const head = await fetch(new URL("/", baseUrl), { method: "HEAD" });
    const missing = await fetch(new URL("/missing", baseUrl));

    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(missing.status).toBe(404);
  });
});
