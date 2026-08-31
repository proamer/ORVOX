<p align="center">
  <img src="https://raw.githubusercontent.com/proamer/ORVOX/main/docs/assets/orvox_banner.png" alt="ORVOX" width="100%">
</p>

# @orvox/cli

`orvox build`, `orvox inspect`, `orvox dev` — the commands that turn an
[`@orvox/core`](https://www.npmjs.com/package/@orvox/core) app into a running server.

Requires Bun 1.4+.

```bash
bun add -d @orvox/cli
```

## Commands

Each takes the entry as its second argument. Omit it and you get `src/app.ts`,
written to `.orvox`.

| Command | What it does |
| --- | --- |
| `orvox build [entry]` | Compiles once, writes all four artifacts, prints how many routes it built |
| `orvox inspect [entry]` | Same build, but prints `manifest`, `analysis`, and `openapi` as JSON on stdout |
| `orvox dev [entry]` | Watches every `.ts` under the entry's directory, rebuilds and restarts on save |
| `--outdir <path>` | Writes artifacts somewhere other than `.orvox` |

```bash
bunx orvox build src/app.ts
bun .orvox/server.generated.ts
```

## What lands in `.orvox/`

| File | What it is |
| --- | --- |
| `server.generated.ts` | The server. The only file you deploy and run |
| `openapi.json` | OpenAPI 3.1, from the same IR as the validators |
| `routes.manifest.json` | Every route with its params, flattened middleware, and a `needs` block |
| `analysis.json` | Compiler warnings — dynamic context access, block-handler fallbacks, late global middleware |

`routes.manifest.json` is worth reading. Its `needs` block tells you precisely
what each route pulls off the request, which is usually where a surprise is hiding.

## When a build fails

Failures carry an `ORVOX_*` code. The common ones:

| Code | Fix |
| --- | --- |
| `ORVOX_APP_REQUIRED` | Move `const app = orvox()` to the top level |
| `ORVOX_INLINE_HANDLER_REQUIRED` | Inline the handler at the route registration |
| `ORVOX_STATIC_DSL_REQUIRED` | Lift `app.use()`, `group()`, and hooks to the outermost scope |
| `ORVOX_UNSUPPORTED_CONTEXT` | Declare the `body` schema, or a `derive()` that supplies the key |
| `ORVOX_AMBIGUOUS_ROUTE` | Two paths reduce to one pattern — merge or reshape them |

In `dev`, the error prints and the watcher keeps going; the last good server
stays up until the next save.

## Docs

[Handbook](https://proamer.github.io/ORVOX/) · [Repository](https://github.com/proamer/ORVOX)

MIT © PROAMER
