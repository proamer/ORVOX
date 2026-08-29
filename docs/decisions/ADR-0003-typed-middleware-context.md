# ADR-0003: Typed middleware context

- Status: accepted
- Date: 2026-08-29

## Decision

`derive()` owns the type of the fields it returns. Route-local middleware tuples and group middleware extend only their following handler context. Chained `app.use(derive(...))` returns a narrowed app type for global derived fields.

```ts
app.get("/private", {
  use: derive(() => ({ auth: { sub: "42" } })),
  handler: ({ auth }) => auth.sub,
});
```

The compiler flattens global, group, and route middleware in declaration order. Derived values become named locals in generated routes; guards are straight-line calls that stop only when they return a `Response`. Header middleware is baked into static responses.

Separate unchained `app.use()` statements still execute globally, but TypeScript cannot mutate the existing variable's generic type. Chain the call when later handlers need its derived fields.
