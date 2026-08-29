import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "@orvox/compiler";

const source = `
  import { orvox, t } from "@orvox/core"
  const Payload = t.object({
    name: t.string({ min: 2, max: 5 }),
    age: t.int({ min: 0, max: 120 }),
    active: t.boolean(),
    nickname: t.optional(t.string({ max: 10 })),
    tags: t.array(t.string({ min: 1 }), { min: 1, max: 2 })
  })
  const app = orvox()
  app.post("/users", {
    body: Payload,
    handler: ({ body }) => ({ accepted: body })
  })
  export default app
`;

describe("compiled body validation", () => {
  let server: Bun.Server<unknown>;
  let baseUrl: URL;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "orvox-m3-"));
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, source, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    process.env.PORT = "0";
    ({ server } = await import(`${pathToFileURL(output.serverPath).href}?m3=${Date.now()}`));
    baseUrl = server.url;
  });

  afterAll(async () => {
    await server?.stop(true);
    delete process.env.PORT;
    await rm(directory, { recursive: true, force: true });
  });

  const post = (body: string, contentType = "application/json; charset=utf-8") =>
    fetch(new URL("/users", baseUrl), {
      method: "POST",
      headers: { "content-type": contentType },
      body,
    });

  test("accepts valid values and omitted optional properties", async () => {
    const response = await post(JSON.stringify({
      name: "Amp",
      age: 35,
      active: true,
      tags: ["dev"],
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accepted: { name: "Amp", age: 35, active: true, tags: ["dev"] },
    });
  });

  test("rejects content-type and malformed JSON with bounded issues", async () => {
    const contentType = await post("{}", "text/plain");
    const malformed = await post("{");

    expect([contentType.status, await contentType.json()]).toEqual([400, {
      error: "VALIDATION_FAILED",
      issues: [{ path: "$", code: "invalid_content_type", message: "Expected application/json content type." }],
    }]);
    expect([malformed.status, await malformed.json()]).toEqual([400, {
      error: "VALIDATION_FAILED",
      issues: [{ path: "$", code: "invalid_json", message: "Request body must be valid JSON." }],
    }]);
  });

  test("requires own properties and enforces scalar bounds", async () => {
    const inherited = await post(JSON.stringify({
      __proto__: { name: "Amp" },
      age: 35,
      active: true,
      tags: ["dev"],
    }));
    const bounds = await post(JSON.stringify({
      name: "A",
      age: 121,
      active: true,
      tags: ["dev"],
    }));

    expect((await inherited.json()).issues[0]).toEqual({
      path: "$.name",
      code: "required",
      message: "Required property is missing.",
    });
    expect((await bounds.json()).issues[0]).toEqual({
      path: "$.name",
      code: "min_length",
      message: "Expected at least 2 characters.",
    });
  });

  test("validates optional values and array items", async () => {
    const optional = await post(JSON.stringify({
      name: "Amp",
      age: 35,
      active: true,
      nickname: "way-too-long",
      tags: ["dev"],
    }));
    const array = await post(JSON.stringify({
      name: "Amp",
      age: 35,
      active: true,
      tags: [""],
    }));

    expect((await optional.json()).issues[0]).toEqual({
      path: "$.nickname",
      code: "max_length",
      message: "Expected at most 10 characters.",
    });
    expect((await array.json()).issues[0]).toEqual({
      path: "$.tags[0]",
      code: "min_length",
      message: "Expected at least 1 character.",
    });
  });

  test("rejects undeclared properties instead of passing them to the handler", async () => {
    const response = await post(JSON.stringify({
      name: "Amp",
      age: 35,
      active: true,
      tags: ["dev"],
      role: "admin",
    }));

    expect(response.status).toBe(400);
    expect((await response.json()).issues[0]).toEqual({
      path: "$.role",
      code: "unknown_property",
      message: "Unknown property is not allowed.",
    });
  });
});
