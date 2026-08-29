# ORVOX alpha architecture

```text
app.ts → TypeScript AST → route/schema/middleware IR → specialized Bun source
                                               └────→ OpenAPI 3.1
```

`@orvox/core` and `@orvox/schema` are typed compile markers. `@orvox/compiler` removes their declarations, preserves application code, and emits native `Bun.serve({ routes })` handlers. Request data is materialized only when AST usage requires it; schemas become route-specific checks; middleware is flattened global → group → route.

Static handlers with static headers remain Bun route values. Dynamic middleware becomes straight-line calls with named derived locals and guard exits, never a runtime middleware array. The fallback handles 404, 405, and OPTIONS outside matched routes, and carries the globally declared static headers so a `header()` middleware is not silently absent from unmatched or rejected requests.

Compiled declarations are erased only when nothing that survives compilation still names them, so `type User = Infer<typeof CreateUser>` keeps both the schema constant and a narrowed `@orvox/core` import in the generated file. Object schemas are closed: undeclared properties are a `400`, which keeps `Infer` the exact shape a handler receives. `app.use()` is order-sensitive by design — it applies to the routes that follow it — and declaring it after a route raises an analysis warning rather than changing that route's behavior.

Production output adds a bounded error response, a 1 MiB default body limit, opt-in hooks, main-only graceful shutdown, WebSocket route-id dispatch, and deterministic OpenAPI. Alpha intentionally requires literal top-level declarations, inline handlers, Bun 1.4+, and static WebSocket paths.
