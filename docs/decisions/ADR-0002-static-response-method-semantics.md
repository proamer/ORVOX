# ADR-0002: Static response and method semantics

- Status: accepted
- Date: 2026-08-29
- Runtime baseline: Bun 1.4.0

## Decision

Compile static handlers to `Response` values inside Bun's per-method route object, not to a path-level response.

```ts
routes: {
  "/health": { GET: new Response("ok") }
}
```

This preserves `GET` semantics while still using Bun's cached static response path. Integration tests call the route repeatedly to guard against consumed bodies.

Bun sends method mismatches to `fetch`, so generated fallback code returns 405 with `Allow`, answers OPTIONS with 204, and leaves unmatched paths as 404. That fallback is outside the matched-route hot path.

