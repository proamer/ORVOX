# ORVOX

**A compile-first TypeScript HTTP framework for Bun that outputs highly optimized, native `Bun.serve` code.**

Orvox shifts the heavy computational overhead of runtime path-parameter routing and schema parsing entirely to build-time. The server you publish to production is not an engine dynamically parsing schema manifests on every request, but a clean, fully inspectable, standalone script.

---

### The Paradigm Shift: AOT Compilation vs Runtime Parsing

Traditional Node.js and Bun frameworks consume substantial runtime clock cycles validating incoming payloads and running recursive route traversals:

```
Request ──> Extract Path ──> Execute RegExp/Trie Traversals ──> Run Dynamic Validation Engine (Zod/TypeBox) ──> Handler
```

Orvox strips this entire runtime virtualization layer:

```
Request ──> O(1) Native Server Path Table Lookup ──> Static Inlined Validation Statements ──> Direct Clean Handler
```

- **0ms Runtime Route Matching**: The compilation step constructs a static routes dictionary consumed directly by native Bun APIs.
- **Inlined Payload Validation**: Your schemas are compiled into raw JavaScript conditional statements inside the generated file—no slow, memory-intensive parser code is imported or executed at runtime.
- **Inspectable Output**: Built artifacts contain clear and highly readable JavaScript/TypeScript. Every line of generated middleware, validation, and route-handling is completely visible and customizable.

---

### Comparison Matrix

| Feature                  |         **Orvox ⚡**          |        Elysia         |         Hono          |     Bun.serve (Raw)      |
| :----------------------- | :---------------------------: | :-------------------: | :-------------------: | :----------------------: |
| **Routing Architecture** |     **AOT Compiled O(1)**     | Runtime Dynamic Tree  | Runtime Dynamic Trie  | Native Prefix Map / O(1) |
| **Validation Overhead**  | **Inlined `if` conditionals** | Runtime JIT (TypeBox) | Runtime Parsing (Zod) |   None (Manual checks)   |
| **Inspectability**       | **Fully transparent output**  | Deep stack / Blackbox | Deep stack / Blackbox |    Fully transparent     |
| **Cold-Start Latency**   | **Instant (Zero-dependency)** |  Higher (Module JIT)  | Higher (JIT/Parsers)  |         Instant          |
| **OpenAPI Generation**   |   **Static build artifact**   |  Dynamic schema loop  | Manual configurations |    Manual custom work    |

---

### Workspace Architecture

Orvox is engineered as a clean, public-ready monorepo structured via a pnpm-workspace in [pnpm-workspace.yaml](pnpm-workspace.yaml). The codebase is divided into independent, publishable packages:

- **[@orvox/schema](packages/schema/package.json)** — Core types and AST schema structures used to declare request fields.
- **[@orvox/core](packages/core/package.json)** — Tiny web app runner API, path binders, and global routing interfaces.
- **[@orvox/compiler](packages/compiler/package.json)** — The core compiler module containing AST code generators, code emitters, and OpenAPI builders.
- **[@orvox/cli](packages/cli/package.json)** — Developer CLI manager and build-watcher orchestrator.

The complete root configuration is managed in [package.json](package.json).

---

### Installation & Quick Start

#### 1. Install dependencies

Deploying Orvox into your standalone application requires downloading the runtime framework and its corresponding build tool:

```bash
# Using pnpm
pnpm add @orvox/core@alpha
pnpm add -D @orvox/cli@alpha

# Using npm
npm install @orvox/core@alpha
npm install --save-dev @orvox/cli@alpha

# Using bun
bun add @orvox/core@alpha
bun add -d @orvox/cli@alpha
```

#### 2. Define, Compile, & Serve

1. Define your web server entry point in a source file, for example, `src/app.ts`.
2. Compile your declarative source code into highly performant server execution code:

   ```bash
   # Using pnpm
   pnpm exec orvox build src/app.ts

   # Using npm (via npx)
   npx orvox build src/app.ts

   # Using bun (via bunx)
   bunx orvox build src/app.ts
   ```

3. Run the optimized native Bun server:
   ```bash
   bun .orvox/server.generated.ts
   ```

---

### Code Compilation Showcase

#### Declared Application Source Code (`src/app.ts`)

```ts
import { header, orvox, t } from "@orvox/core";

const CreateUser = t.object({
  name: t.string({ min: 1, max: 100 }),
  age: t.int({ min: 0, max: 150 }),
});

const app = orvox({ maxRequestBodySize: 16384 });
app.use(header("x-powered-by", "orvox"));

app.post("/users", {
  body: CreateUser,
  handler: ({ body }) =>
    Response.json({ ...body, id: crypto.randomUUID() }, { status: 201 }),
});

export default app;
```

#### Run the Compiler (Example)

Before deploying, compile your application to reify static handler files:

```bash
# Using pnpm
pnpm exec orvox build src/app.ts

# Using npm
npx orvox build src/app.ts

# Using Bun
bunx orvox build src/app.ts
```

#### Compiled Output File (`.orvox/server.generated.ts`)

Real output, abridged only where the per-property checks repeat:

```ts
// Generated by ORVOX. Do not edit.

const __orvoxGlobalHeaders: Record<string, string> = {"x-powered-by":"orvox"};

function __orvoxValidationError(path: string, code: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error: "VALIDATION_FAILED", issues: [{ path, code, message }] }, { status: 400, headers });
}

export const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  development: false,
  maxRequestBodySize: 16384,
  error() {
    return new Response("Internal Server Error", { status: 500, headers: __orvoxGlobalHeaders });
  },

  routes: {
    "/users": {
      async POST(req) {
        const __orvoxContentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (__orvoxContentType !== "application/json" && !__orvoxContentType?.endsWith("+json")) return __orvoxValidationError("$", "invalid_content_type", "Expected application/json content type.", {"x-powered-by":"orvox"});
        let __orvoxBody: any;
        try {
          __orvoxBody = await req.json();
        } catch {
          return __orvoxValidationError("$", "invalid_json", "Request body must be valid JSON.", {"x-powered-by":"orvox"});
        }
        if (__orvoxBody === null || typeof __orvoxBody !== "object" || Array.isArray(__orvoxBody)) return __orvoxValidationError("$", "invalid_type", "Expected an object.", {"x-powered-by":"orvox"});
        const __orvoxValue0 = __orvoxBody as Record<string, unknown>;
        if (!Object.hasOwn(__orvoxValue0, "name")) return __orvoxValidationError("$" + ".name", "required", "Required property is missing.", {"x-powered-by":"orvox"});
        const __orvoxValue1: unknown = __orvoxValue0["name"];
        if (typeof __orvoxValue1 !== "string") return __orvoxValidationError("$" + ".name", "invalid_type", "Expected a string.", {"x-powered-by":"orvox"});
        // … min/max length for name, then the same shape of checks for age …
        for (const __orvoxKey3 of Object.keys(__orvoxValue0)) {
          if (!["name","age"].includes(__orvoxKey3)) return __orvoxValidationError("$" + "." + __orvoxKey3, "unknown_property", "Unknown property is not allowed.", {"x-powered-by":"orvox"});
        }
        const body = __orvoxBody;
        const __orvoxOutput = Response.json({ ...body, id: crypto.randomUUID() }, { status: 201 });
        __orvoxOutput.headers.set("x-powered-by", "orvox");
        return __orvoxOutput;
      },
    },
  },
  fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/users") {
      const allow = "POST, OPTIONS";
      if (req.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: { ...__orvoxGlobalHeaders, allow } });
      }
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { ...__orvoxGlobalHeaders, allow },
      });
    }
    return new Response("Not Found", { status: 404, headers: __orvoxGlobalHeaders });
  },
});
```

A live, fully executable CRUD example is available in [examples/crud/src/app.ts](examples/crud/src/app.ts).

---

### Project Layout & Build Artifacts

Running `orvox build` reifies a dedicated, non-hidden `.orvox/` directory at your root containing four primary compile-time products:

- `server.generated.ts` — The clean, dependency-free code serving requests.
- `openapi.json` — Pre-calculated OpenAPI 3.1 schema specification.
- `routes.manifest.json` — Manifest of compiled path rules and internal routing metadata.
- `analysis.json` — Static compiler diagnostics and optimization recommendations.

---

### Local Development Flow

For engineers looking to contribute, modify the framework parts, or audit the compiler engines locally:

#### Initial Setup & Checks

Ensure Bun 1.4+ and pnpm are installed to initiate packages:

```powershell
# Clone the repository, then configure dependencies
pnpm install

# Run type checkers, compiler validation tests, and test suites
pnpm check
```

The unified validation suite runs type-checking, compiles the basic sample, and triggers Bun unit tests across modules.

#### Performance Analysis and Smoke Testing

We maintain standard benchmark scripts to compare performance objectively against other high-end libraries like Elysia and Hono using standard benchmarks under the benchmarks directory:

```powershell
# Run smoke server benchmarks
pnpm bench:smoke
```

_(Review [benchmarks/README.md](benchmarks/README.md) for environment requirements, duration configurations, and reporting scripts)._

---

### Publishing & Release Pipeline

The distribution of core CLI, Schema, and Compiler packages to public npm repositories is managed via continuous integration pipelines.

#### Local Dry-Run Pack Verification

Before publishing, packages can be compiled and packed locally to check package contents, sizes, and structure integrity using [scripts/pack-alpha.ts](scripts/pack-alpha.ts):

```powershell
# Compile and output local deployment tarballs under artifacts/
pnpm pack:alpha
```

#### CI/CD Workflows

- **Code Integrity Check**: The workflow in [.github/workflows/ci.yml](.github/workflows/ci.yml) executes on every push and pull request to ensure types and tests pass on any modification.
- **Automated Public Release**: The release action in [.github/workflows/publish.yml](.github/workflows/publish.yml) uses GitHub Actions workflows to deploy tagged releases. To initiate a release:
  1. Go to the Actions tab on the GitHub Repository.
  2. Select the `publish alpha` workflow.
  3. Run the workflow manually (requires repository owner access and `NPM_TOKEN` organization secret setup).
  4. The workflow automatically publishes updated public versions of `@orvox/schema`, `@orvox/core`, `@orvox/compiler`, and `@orvox/cli` to the public registry.

---

### Current Support Matrix

- [x] **Type-Safe Dynamic Router**: Compile-time GET, POST, PUT, PATCH, DELETE and path param parsing
- [x] **High-Speed Validator compiler**: Objects, Arrays, Inputs, and custom limits
- [x] **Flat-Tree Middleware Pipeline**: Global decorators (`header()`), secured guards, and data derivation
- [x] **Automatic Spec Reification**: Compiles and outputs clean OpenAPI 3.1 documents at build-time
- [x] **WebSockets integration**: Fast connection bindings mapping to Bun's native protocol handler
- [ ] **Tree-shaking Optimizer**: Automatic pruning of unused module branches inside emitted helpers

### Alpha Semantics You Should Know

- **Bodies are closed.** Object schemas reject undeclared properties with a `400` / `unknown_property` issue, so a request can never smuggle extra fields into a handler. OpenAPI output mirrors this with `additionalProperties: false`.
- **`app.use()` is positional.** Global middleware applies only to routes declared *after* it, exactly as written. Declaring it late is legal but emits an `ORVOX_LATE_GLOBAL_MIDDLEWARE` warning in `.orvox/analysis.json`.
- **`header()` middleware covers the whole route.** Static headers are attached to handler results, guard short-circuits, and validation `400`s alike. Headers registered globally also reach the fallback `404` / `405` / `OPTIONS` responses and the error handler.
- **Groups do not nest.** `app.group()` accepts routes only; `group.group()` and `group.use()` fail the build with `ORVOX_STATIC_DSL_REQUIRED` rather than silently dropping routes.
- **Schema bounds are integers.** `min` / `max` are integer literals in both the compiler and the runtime descriptors.
