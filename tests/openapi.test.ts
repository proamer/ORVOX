import { describe, expect, test } from "bun:test";
import { compileSource } from "@orvox/compiler";

const build = (body: string) => compileSource(`
  import { orvox, t } from "@orvox/core"
  const app = orvox({ openapi: { title: "T", version: "1.0.0" } })
  ${body}
  export default app
`, { entryPath: "src/app.ts" });

const operation = (body: string, path: string, method = "get") =>
  build(body).openapi.paths[path]![method] as Record<string, any>;

describe("OpenAPI describes what a route actually accepts", () => {
  test("declares query parameters, with their converted types", () => {
    const op = operation(`
      app.get("/search", {
        query: t.object({ q: t.string({ min: 1 }), page: t.optional(t.int({ min: 1 })) }),
        handler: ({ query }) => query,
      })
    `, "/search");

    expect(op.parameters).toEqual([
      { name: "q", in: "query", required: true, schema: { type: "string", minLength: 1 } },
      { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1 } },
    ]);
  });

  test("gives path params their declared type instead of always string", () => {
    const op = operation(`
      app.get("/users/:id", {
        params: t.object({ id: t.int({ min: 1 }) }),
        handler: ({ params }) => params,
      })
    `, "/users/{id}");

    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "integer", minimum: 1 } },
    ]);
  });

  test("falls back to string for a param with no schema", () => {
    const op = operation(`app.get("/users/:id", ({ params }) => params)`, "/users/{id}");
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
  });

  test("lists path params before query params", () => {
    const op = operation(`
      app.get("/users/:id", {
        query: t.object({ full: t.optional(t.boolean()) }),
        handler: ({ params, query }) => ({ ...params, ...query }),
      })
    `, "/users/{id}");
    expect(op.parameters.map((p: any) => [p.in, p.name])).toEqual([
      ["path", "id"],
      ["query", "full"],
    ]);
  });
});

describe("OpenAPI describes what a route returns", () => {
  test("gives 200 a schema when one is declared", () => {
    const op = operation(`
      app.get("/me", {
        response: t.object({ id: t.string(), age: t.int() }),
        handler: () => ({ id: "a", age: 1 }),
      })
    `, "/me");

    expect(op.responses["200"]).toEqual({
      description: "Successful response",
      content: {
        "application/json": {
          schema: {
            type: "object",
            properties: { id: { type: "string" }, age: { type: "integer" } },
            additionalProperties: false,
            required: ["id", "age"],
          },
        },
      },
    });
  });

  test("leaves 200 undescribed when nothing is declared", () => {
    const op = operation(`app.get("/me", () => "hi")`, "/me");
    expect(op.responses["200"]).toEqual({ description: "Successful response" });
  });

  test("a declared response costs nothing at runtime", () => {
    const result = build(`
      app.get("/me", {
        response: t.object({ id: t.string() }),
        handler: () => ({ id: "a" }),
      })
    `);
    // the schema shapes the document and the types, and is not re-checked per request
    expect(result.code).not.toContain("__orvoxResponseValidation");
    expect(result.manifest.routes[0]!.responseSchema).toEqual({
      kind: "object",
      properties: [{ name: "id", required: true, schema: { kind: "string" } }],
    });
  });
});
