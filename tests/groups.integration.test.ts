import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "@orvox/compiler";

const source = `
  import { derive, guard, header, orvox } from "@orvox/core"

  const app = orvox()

  const token = guard(({ headers }) =>
    headers.authorization ? undefined : new Response("Unauthorized", { status: 401 }))
  const who = derive(({ headers }) => ({ operator: headers["x-operator"] ?? "anon" }))

  app.group("/api", { use: [header("x-api", "1")] }, api => {
    api.get("/ping", () => "pong")

    api.group("/v2", { use: [token] }, v2 => {
      v2.get("/health", () => "ok")

      v2.group("/admin", { use: [who] }, admin => {
        admin.get("/whoami", ({ operator }) => ({ operator }))
      })
    })
  })

  export default app
`;

let server: Bun.Server<unknown>;
let baseUrl: URL;
let directory: string;

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "orvox-groups-"));
  const entryPath = join(directory, "app.ts");
  await writeFile(entryPath, source, "utf8");
  const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
  process.env.PORT = "0";
  ({ server } = await import(`${pathToFileURL(output.serverPath).href}?groups=${Date.now()}`));
  baseUrl = server.url;
});

afterAll(async () => {
  await server?.stop(true);
  delete process.env.PORT;
  await rm(directory, { recursive: true, force: true });
});

test("joins prefixes through every level of nesting", async () => {
  expect(await (await fetch(new URL("/api/ping", baseUrl))).text()).toBe("pong");
  expect((await fetch(new URL("/api/v2/health", baseUrl), {
    headers: { authorization: "t" },
  })).status).toBe(200);
});

test("an outer group's header reaches routes nested below it", async () => {
  const response = await fetch(new URL("/api/ping", baseUrl));
  expect(response.headers.get("x-api")).toBe("1");
});

test("an inner guard does not run for routes outside it", async () => {
  expect((await fetch(new URL("/api/ping", baseUrl))).status).toBe(200);
});

test("an inner guard protects everything below it", async () => {
  expect((await fetch(new URL("/api/v2/health", baseUrl))).status).toBe(401);
  expect((await fetch(new URL("/api/v2/admin/whoami", baseUrl))).status).toBe(401);
});

test("middleware accumulates down the nesting rather than replacing", async () => {
  const response = await fetch(new URL("/api/v2/admin/whoami", baseUrl), {
    headers: { authorization: "t", "x-operator": "amp" },
  });
  expect(response.headers.get("x-api")).toBe("1");
  expect(await response.json()).toEqual({ operator: "amp" });
});
