<p align="center">
  <img src="https://raw.githubusercontent.com/proamer/ORVOX/main/docs/assets/orvox_banner.png" alt="ORVOX" width="100%">
</p>

# @orvox/compiler

The engine behind [`@orvox/cli`](https://www.npmjs.com/package/@orvox/cli): it reads
an [`@orvox/core`](https://www.npmjs.com/package/@orvox/core) app with the TypeScript
AST and emits a `Bun.serve` file, an OpenAPI document, a route manifest, and an
analysis report.

> Most people want the CLI. Reach for this package to embed the compiler in your
> own tooling.

Requires Bun 1.4+.

```bash
bun add -d @orvox/compiler
```

## API

```ts
import { compile, compileSource, CompileError } from "@orvox/compiler";

// reads a file, writes .orvox/ next to it
const result = await compile("src/app.ts", { outDir: ".orvox" });
result.serverPath;   // the file to run
result.manifest;     // routes, params, flattened middleware, needs
result.analysis;     // warnings
result.openapi;      // OpenAPI 3.1 document

// same pipeline, nothing written to disk
const inMemory = compileSource(source, { entryPath: "src/app.ts" });
```

Failures throw a `CompileError` carrying a `code` — the `ORVOX_*` identifier — and
a message naming the construct it refused.

## The pipeline

```
app.ts → TypeScript AST → route/schema/middleware IR → specialized Bun source
                                             └────→ OpenAPI 3.1
```

- Routes become a literal object handed to `Bun.serve({ routes })`; Bun's own path table does the lookup.
- Schemas become inline `if` statements — no validator is imported into the output.
- Middleware is flattened global → group → route into straight-line code.
- Request data is materialized only where the AST proves it is used: a handler that never reads `query` gets no `new URL()`.

Compiled declarations are erased once nothing that survives still names them.
Dead code *you* wrote is copied through verbatim rather than guessed at.

## Deliberate limits

Route paths, schemas, middleware, and hooks must be top-level literal
declarations, and handlers must be inline function expressions. The compiler
refuses what it cannot read statically instead of guessing — that refusal is the
feature.

## Docs

[Handbook](https://proamer.github.io/ORVOX/) · [Architecture](https://github.com/proamer/ORVOX/blob/main/docs/architecture.md) · [Repository](https://github.com/proamer/ORVOX)

MIT © PROAMER
