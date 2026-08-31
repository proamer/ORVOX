<p align="center">
  <img src="https://raw.githubusercontent.com/proamer/ORVOX/main/docs/assets/orvox_banner.png" alt="ORVOX" width="100%">
</p>

# @orvox/core

The typed surface you write your app against: routes, middleware, hooks, and WebSockets.

> **This package is not a runtime.** It is a set of compile markers with types.
> `bun src/app.ts` starts nothing. [`@orvox/cli`](https://www.npmjs.com/package/@orvox/cli)
> reads what you declare here and writes a `Bun.serve` file — that file is your server.

Requires Bun 1.4+.

```bash
bun add @orvox/core
bun add -d @orvox/cli
```

## Write it

```ts
import { derive, guard, header, orvox, t } from "@orvox/core";

const app = orvox({
  maxRequestBodySize: 16384,
  openapi: { title: "Users API", version: "1.0.0" },
});

app.use(header("x-powered-by", "orvox"));

app.get("/users/:id", ({ params }) => ({ id: params.id }));

app.post("/users", {
  body: t.object({ name: t.string({ min: 1 }), age: t.int({ min: 0 }) }),
  handler: ({ body }) => Response.json(body, { status: 201 }),
});

const requireToken = guard(({ headers }) =>
  headers.authorization ? undefined : new Response("Unauthorized", { status: 401 }));

const operator = derive(({ headers }) => ({ operator: headers["x-operator"] ?? "unknown" }));

app.group("/admin", { use: [requireToken, operator] }, admin => {
  admin.get("/stats", ({ operator }) => ({ readBy: operator }));
});

export default app;
```

## Build it

```bash
bunx orvox build src/app.ts
bun .orvox/server.generated.ts
```

## What compiles into what

| You write | The output contains |
| --- | --- |
| `app.get("/users/:id", …)` | an entry in `Bun.serve({ routes })` — no matcher runs at request time |
| `body: t.object({ … })` | `typeof` and `.length` checks inline in the handler — no validator is shipped |
| `header(name, value)` | the value baked into every response the route can produce |
| `guard(fn)` | an early `return` |
| `derive(fn)` | a named local, its type carried into the handler context |

Everything must be statically readable: top-level literal declarations and inline
handlers. The compiler refuses what it cannot see rather than guessing.

## Notes that save an hour

- **Bodies are closed.** An undeclared property is a `400`, so `Infer<typeof Schema>` is exactly what arrives.
- **`headers` is a plain object**, not a `Headers` instance — `headers.authorization`, not `headers.get(…)`. Only the keys you name are read off the request.
- **`app.use()` is positional.** It covers the routes declared after it.
- **Groups do not nest.** Declare group middleware in the group options.

## Docs

[Handbook](https://proamer.github.io/ORVOX/) · [Repository](https://github.com/proamer/ORVOX)

MIT © PROAMER
