import { describe, expect, test } from "bun:test";
import { CompileError, compileSource } from "@orvox/compiler";

const basicSource = `
import { orvox } from "@orvox/core"

const app = orvox()

app.get("/", () => "hello")
app.get("/users/:id", ({ params }) => ({ id: params.id }))

export default app
`;

describe("compileSource", () => {
  test("lowers static and parameter routes into Route IR", () => {
    const result = compileSource(basicSource, {
      entryPath: "src/app.ts",
      outputPath: ".orvox/server.generated.ts",
    });

    expect(result.manifest.routes).toEqual([
      {
        method: "GET",
        path: "/",
        params: [],
        needs: {
          body: false,
          query: false,
          headers: false,
          cookies: false,
          server: false,
          rawRequest: false,
        },
        middleware: [],
        responseMode: "static",
      },
      {
        method: "GET",
        path: "/users/:id",
        params: ["id"],
        needs: {
          body: false,
          query: false,
          headers: false,
          cookies: false,
          server: false,
          rawRequest: false,
        },
        middleware: [],
        responseMode: "json",
      },
    ]);
    expect(result.analysis.warnings).toEqual([]);
  });

  test("rejects route registration hidden inside runtime control flow", () => {
    const source = `
      import { orvox } from "@orvox/core"
      const app = orvox()
      if (process.env.ENABLE_ROUTE) app.get("/hidden", () => "nope")
      export default app
    `;

    expect(() => compileSource(source, { entryPath: "src/app.ts" })).toThrow(
      new CompileError(
        "ORVOX_STATIC_ROUTE_REQUIRED",
        "Routes must be registered as top-level statements.",
      ),
    );
  });

  test("rejects duplicate method and path pairs", () => {
    const source = `
      import { orvox } from "@orvox/core"
      const app = orvox()
      app.get("/same", () => "first")
      app.get("/same", () => "second")
      export default app
    `;

    expect(() => compileSource(source, { entryPath: "src/app.ts" })).toThrow(
      new CompileError(
        "ORVOX_DUPLICATE_ROUTE",
        'Duplicate route: GET "/same".',
      ),
    );
  });

  test("rejects non-literal route paths", () => {
    const source = `
      import { orvox } from "@orvox/core"
      const app = orvox()
      const path = "/dynamic"
      app.get(path, () => "nope")
      export default app
    `;

    expect(() => compileSource(source, { entryPath: "src/app.ts" })).toThrow(
      new CompileError(
        "ORVOX_LITERAL_PATH_REQUIRED",
        "Route paths must be string literals.",
      ),
    );
  });

  test("rejects routes that differ only by parameter name", () => {
    const source = `
      import { orvox } from "@orvox/core"
      const app = orvox()
      app.get("/users/:id", ({ params }) => params.id)
      app.get("/users/:name", ({ params }) => params.name)
      export default app
    `;

    expect(() => compileSource(source, { entryPath: "src/app.ts" })).toThrow(
      new CompileError(
        "ORVOX_AMBIGUOUS_ROUTE",
        'Ambiguous route pattern: GET "/users/:name" conflicts with "/users/:id".',
      ),
    );
  });

  test("reports block handlers that require the conservative adapter", () => {
    const source = `
      import { orvox } from "@orvox/core"
      const app = orvox()
      app.get("/block", () => { return "hello" })
      export default app
    `;

    const result = compileSource(source, { entryPath: "src/app.ts" });

    expect(result.analysis.warnings).toEqual([
      {
        code: "ORVOX_BLOCK_HANDLER_FALLBACK",
        route: "GET /block",
        message:
          "Block handler uses the conservative response adapter in v0.1.",
      },
    ]);
  });

  test("nests groups, accumulating prefix and middleware down each level", () => {
    const result = compileSource(`
      import { orvox, header } from "@orvox/core"
      const app = orvox()
      app.group("/v1", { use: header("x-g", "1") }, group => {
        group.get("/ping", () => "pong")
        group.group("/deep", { use: header("x-d", "1") }, inner => {
          inner.get("/leaf", () => "leaf")
        })
      })
      export default app
    `, { entryPath: "src/app.ts" });

    expect(result.manifest.routes.map(route => route.path)).toEqual(["/v1/ping", "/v1/deep/leaf"]);
    // the outer header reaches the inner route, and the inner one does not
    // escape upwards
    expect(result.manifest.routes.map(route => route.middleware)).toEqual([
      [{ kind: "header", name: "x-g", value: "1" }],
      [
        { kind: "header", name: "x-g", value: "1" },
        { kind: "header", name: "x-d", value: "1" },
      ],
    ]);
  });

  test("still rejects group.use(), which would hide middleware from the group options", () => {
    const source = `
      import { orvox, header } from "@orvox/core"
      const app = orvox()
      app.group("/v1", { use: header("x-g", "1") }, group => {
        group.use(header("x-inner", "1"))
        group.get("/ping", () => "pong")
      })
      export default app
    `;
    expect(() => compileSource(source, { entryPath: "src/app.ts" })).toThrow(
      new CompileError(
        "ORVOX_STATIC_DSL_REQUIRED",
        "group.use() is not supported; declare middleware in the group options.",
      ),
    );
  });

  test("warns when global middleware is declared after a route", () => {
    const source = `
      import { orvox, header } from "@orvox/core"
      const app = orvox()
      app.get("/before", () => "b")
      app.use(header("x-late", "1"))
      app.get("/after", () => "a")
      export default app
    `;

    const result = compileSource(source, { entryPath: "src/app.ts" });

    expect(result.analysis.warnings).toEqual([
      {
        code: "ORVOX_LATE_GLOBAL_MIDDLEWARE",
        route: "GET /before",
        message: "app.use() only applies to routes declared after it.",
      },
    ]);
    expect(result.manifest.routes[0]!.middleware).toEqual([]);
    expect(result.manifest.routes[1]!.middleware).toEqual([
      { kind: "header", name: "x-late", value: "1" },
    ]);
  });

  test("records the entry as a path relative to the working directory", () => {
    const result = compileSource(basicSource, {
      entryPath: `${process.cwd()}/src/app.ts`,
    });

    expect(result.manifest.entry).toBe("src/app.ts");
    expect(result.analysis.entry).toBe("src/app.ts");
  });

  test("keeps schema declarations that surviving code still references", () => {
    const source = `
      import { orvox, t, type Infer } from "@orvox/core"
      const CreateUser = t.object({ name: t.string() })
      type User = Infer<typeof CreateUser>
      const store: User[] = []
      const app = orvox()
      app.post("/users", { body: CreateUser, handler: ({ body }) => { store.push(body); return body } })
      export default app
    `;

    const { code } = compileSource(source, { entryPath: "src/app.ts" });

    expect(code).toContain('import { t, type Infer } from "@orvox/core";');
    expect(code).toContain("const CreateUser = t.object({ name: t.string() });");
    expect(code).not.toContain("orvox(");
  });

  test("drops schema declarations that nothing else references", () => {
    const source = `
      import { orvox, t } from "@orvox/core"
      const CreateUser = t.object({ name: t.string() })
      const app = orvox()
      app.post("/users", { body: CreateUser, handler: ({ body }) => body })
      export default app
    `;

    const { code } = compileSource(source, { entryPath: "src/app.ts" });

    expect(code).not.toContain("CreateUser");
    expect(code).not.toContain("@orvox/core");
  });
});
