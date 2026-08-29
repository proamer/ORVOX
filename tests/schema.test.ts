import { expect, test } from "bun:test";
import { compileSource } from "@orvox/compiler";
import { t } from "@orvox/core";

test("schema builders create immutable compile descriptors", () => {
  const schema = t.object({
    name: t.string({ min: 1, max: 20 }),
    age: t.int({ min: 0, max: 150 }),
    active: t.boolean(),
    nickname: t.optional(t.string({ max: 30 })),
    tags: t.array(t.string({ min: 1 }), { min: 1, max: 3 }),
  });

  expect(schema).toEqual({
    kind: "object",
    properties: {
      name: { kind: "string", min: 1, max: 20 },
      age: { kind: "integer", min: 0, max: 150 },
      active: { kind: "boolean" },
      nickname: { kind: "optional", inner: { kind: "string", max: 30 } },
      tags: {
        kind: "array",
        items: { kind: "string", min: 1 },
        min: 1,
        max: 3,
      },
    },
  });
  expect(Object.isFrozen(schema)).toBe(true);
  expect(Object.isFrozen(schema.properties)).toBe(true);
});

test("compiler and runtime reject the same fractional bounds", () => {
  const source = `
    import { orvox, t } from "@orvox/core"
    const app = orvox()
    app.post("/x", { body: t.object({ name: t.string({ min: 1.5 }) }), handler: ({ body }) => body })
    export default app
  `;

  expect(() => t.string({ min: 1.5 })).toThrow(TypeError);
  expect(() => compileSource(source, { entryPath: "src/app.ts" })).toThrow(
    'Schema option "min" must be an integer literal.',
  );
});

test("compiler lowers schemas into route IR and straight-line checks", () => {
  const result = compileSource(`
    import { orvox, t } from "@orvox/core"
    const User = t.object({ name: t.string({ min: 1 }), age: t.int({ min: 0 }) })
    const app = orvox()
    app.post("/users", { body: User, handler: ({ body }) => body })
    export default app
  `, { entryPath: "src/app.ts" });

  expect(result.manifest.routes[0]?.schema).toEqual({
    kind: "object",
    properties: [
      { name: "name", required: true, schema: { kind: "string", min: 1 } },
      { name: "age", required: true, schema: { kind: "integer", min: 0 } },
    ],
  });
  expect(result.code).toContain("Object.hasOwn");
  expect(result.code).toContain("Number.isInteger");
  expect(result.code).not.toContain("User");
  expect(result.code).not.toContain("validateSchema");
});
