import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile, compileSource } from "@orvox/compiler";

const source = `
  import { orvox, t } from "@orvox/core"

  const app = orvox()

  app.post("/reading", {
    body: t.object({
      celsius: t.number({ min: -273.15, max: 1000 }),
      unit: t.literal("metric"),
      status: t.enum(["ok", "stale", "missing"]),
    }),
    handler: ({ body }) => body,
  })

  app.post("/event", {
    body: t.union("type", [
      t.object({ type: t.literal("click"), x: t.int(), y: t.int() }),
      t.object({ type: t.literal("key"), code: t.string({ min: 1 }) }),
    ]),
    handler: ({ body }) => body,
  })

  export default app
`;

let server: Bun.Server<unknown>;
let baseUrl: URL;
let directory: string;

const post = (path: string, body: unknown) =>
  fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "orvox-shapes-"));
  const entryPath = join(directory, "app.ts");
  await writeFile(entryPath, source, "utf8");
  const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
  process.env.PORT = "0";
  ({ server } = await import(`${pathToFileURL(output.serverPath).href}?shapes=${Date.now()}`));
  baseUrl = server.url;
});

afterAll(async () => {
  await server?.stop(true);
  delete process.env.PORT;
  await rm(directory, { recursive: true, force: true });
});

test("accepts a fractional number where t.number is declared", async () => {
  const body = { celsius: 21.5, unit: "metric", status: "ok" };
  expect(await (await post("/reading", body)).json()).toEqual(body);
});

test("t.number still rejects a non-number", async () => {
  const response = await post("/reading", { celsius: "21.5", unit: "metric", status: "ok" });
  expect((await response.json()).issues[0]).toEqual({
    path: "$.celsius",
    code: "invalid_type",
    message: "Expected a number.",
  });
});

test("t.number enforces fractional bounds", async () => {
  const response = await post("/reading", { celsius: -300, unit: "metric", status: "ok" });
  expect((await response.json()).issues[0].code).toBe("min_value");
});

test("t.literal accepts only its own value", async () => {
  const response = await post("/reading", { celsius: 1, unit: "imperial", status: "ok" });
  expect((await response.json()).issues[0]).toEqual({
    path: "$.unit",
    code: "invalid_value",
    message: 'Expected "metric".',
  });
});

test("t.enum names what it will accept", async () => {
  const response = await post("/reading", { celsius: 1, unit: "metric", status: "nope" });
  expect((await response.json()).issues[0]).toEqual({
    path: "$.status",
    code: "invalid_value",
    message: 'Expected one of "ok", "stale", "missing".',
  });
});

test("a discriminated union validates the branch its tag selects", async () => {
  const click = { type: "click", x: 1, y: 2 };
  expect(await (await post("/event", click)).json()).toEqual(click);
  const key = { type: "key", code: "Escape" };
  expect(await (await post("/event", key)).json()).toEqual(key);
});

test("the error comes from the selected branch, not from every branch at once", async () => {
  const response = await post("/event", { type: "key", code: "" });
  expect((await response.json()).issues[0]).toEqual({
    path: "$.code",
    code: "min_length",
    message: "Expected at least 1 character.",
  });
});

test("an unknown tag names the tags that exist", async () => {
  const response = await post("/event", { type: "scroll" });
  expect((await response.json()).issues[0]).toEqual({
    path: "$.type",
    code: "invalid_value",
    message: 'Expected one of "click", "key".',
  });
});

test("a union whose branches cannot be told apart fails the build", () => {
  expect(() => compileSource(`
    import { orvox, t } from "@orvox/core"
    const app = orvox()
    app.post("/x", {
      body: t.union("type", [
        t.object({ type: t.literal("a") }),
        t.object({ type: t.string() }),
      ]),
      handler: ({ body }) => body,
    })
    export default app
  `, { entryPath: "src/app.ts" })).toThrow(
    'Union branch 2 must set "type" to a literal so the tag can select it.',
  );
});
