import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, compileSource } from "@orvox/compiler";

const source = `
  import { derive, guard, header, orvox } from "@orvox/core"
  const app = orvox()
  app.use(header("x-powered-by", "orvox"))
  app.use(derive(() => ({ globalStep: "global" })))
  app.get("/public", () => "public")
  app.get("/guarded", {
    use: [
      derive(({ headers }) => ({ token: headers.authorization })),
      guard(({ token }) => token === "secret" ? undefined : new Response("Unauthorized", { status: 401 }))
    ],
    handler: ({ token }) => ({ token })
  })
  app.group("/api", {
    use: derive(({ globalStep }) => ({ groupStep: globalStep + ">group" }))
  }, group => {
    group.get("/order", {
      use: derive(({ groupStep }) => ({ routeStep: groupStep + ">route" })),
      handler: ({ globalStep, groupStep, routeStep }) => ({ globalStep, groupStep, routeStep })
    })
  })
  export default app
`;

test("compiler flattens middleware in global, group, route order", () => {
  const result = compileSource(source, { entryPath: "src/app.ts" });
  const route = result.manifest.routes.find(item => item.path === "/api/order");

  expect(route?.middleware).toEqual([
    { kind: "header", name: "x-powered-by", value: "orvox" },
    { kind: "derive", keys: ["globalStep"] },
    { kind: "derive", keys: ["groupStep"] },
    { kind: "derive", keys: ["routeStep"] },
  ]);
  expect(result.code).not.toContain("for (const middleware");
  expect(result.code).not.toContain(".reduce(");
});

describe("generated middleware", () => {
  let server: Bun.Server<unknown>;
  let baseUrl: URL;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "orvox-m4-"));
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, source, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    process.env.PORT = "0";
    ({ server } = await import(`${pathToFileURL(output.serverPath).href}?m4=${Date.now()}`));
    baseUrl = server.url;
  });

  afterAll(async () => {
    await server?.stop(true);
    delete process.env.PORT;
    await rm(directory, { recursive: true, force: true });
  });

  test("bakes static headers into repeated static responses", async () => {
    const first = await fetch(new URL("/public", baseUrl));
    const second = await fetch(new URL("/public", baseUrl));

    expect([await first.text(), first.headers.get("x-powered-by")]).toEqual(["public", "orvox"]);
    expect([await second.text(), second.headers.get("x-powered-by")]).toEqual(["public", "orvox"]);
  });

  test("short-circuits guards and exposes derived context", async () => {
    const denied = await fetch(new URL("/guarded", baseUrl));
    const allowed = await fetch(new URL("/guarded", baseUrl), {
      headers: { authorization: "secret" },
    });

    expect([denied.status, await denied.text(), denied.headers.get("x-powered-by")]).toEqual([401, "Unauthorized", "orvox"]);
    expect(await allowed.json()).toEqual({ token: "secret" });
  });

  test("prefixes groups and preserves middleware order", async () => {
    const response = await fetch(new URL("/api/order", baseUrl));
    const unprefixed = await fetch(new URL("/order", baseUrl));

    expect(await response.json()).toEqual({
      globalStep: "global",
      groupStep: "global>group",
      routeStep: "global>group>route",
    });
    expect(response.headers.get("x-powered-by")).toBe("orvox");
    expect(unprefixed.status).toBe(404);
  });

  test("keeps global headers on guard, 404, 405, and OPTIONS responses", async () => {
    const unauthorized = await fetch(new URL("/guarded", baseUrl));
    const missing = await fetch(new URL("/order", baseUrl));
    const wrongMethod = await fetch(new URL("/public", baseUrl), { method: "POST" });
    const options = await fetch(new URL("/public", baseUrl), { method: "OPTIONS" });

    expect(unauthorized.status).toBe(401);
    expect(missing.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(options.status).toBe(204);
    for (const response of [unauthorized, missing, wrongMethod, options]) {
      expect(response.headers.get("x-powered-by")).toBe("orvox");
    }
    expect(wrongMethod.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
