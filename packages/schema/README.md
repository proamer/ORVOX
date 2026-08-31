<p align="center">
  <img src="https://raw.githubusercontent.com/proamer/ORVOX/main/docs/assets/orvox_banner.png" alt="ORVOX" width="100%">
</p>

# @orvox/schema

The `t` builders and `Infer<>`, re-exported by
[`@orvox/core`](https://www.npmjs.com/package/@orvox/core) — install that instead
unless you are building on the compiler directly.

> **This is not a validator library.** Nothing here validates anything at runtime.
> `t.object({ … })` returns a frozen description that
> [`@orvox/compiler`](https://www.npmjs.com/package/@orvox/compiler) reads at build
> time and turns into `if` statements inside your generated server. No validator
> code is shipped to production.

## Builders

| Builder | Compiles to |
| --- | --- |
| `t.string({ min, max })` | a `typeof` check and a `.length` check |
| `t.int({ min, max })` | an integer check; the bounds must be integer literals too |
| `t.boolean()` | a `typeof` check |
| `t.optional(inner)` | a presence check — the property may be absent, not present-and-`undefined` |
| `t.array(item, { min, max })` | an `Array.isArray` check plus per-element checks; bounds count elements |
| `t.object({ … })` | per-property checks **plus a closed-object check** |

```ts
import { t, type Infer } from "@orvox/schema";

const CreateUser = t.object({
  name: t.string({ min: 1, max: 100 }),
  age: t.int({ min: 0, max: 150 }),
  tags: t.optional(t.array(t.string({ min: 1 }), { max: 8 })),
});

type CreateUser = Infer<typeof CreateUser>;
```

## Objects are closed

An undeclared property is a `400`, not a silently dropped field. That is what
makes `Infer<>` exactly the shape a handler receives, and the generated OpenAPI
mirrors it with `additionalProperties: false`.

Every rejection has the same shape:

```json
{ "error": "VALIDATION_FAILED",
  "issues": [{ "path": "$.name", "code": "invalid_type", "message": "Expected a string." }] }
```

Issue codes: `invalid_content_type`, `invalid_json`, `invalid_type`, `required`,
`unknown_property`, plus the min/max cases per kind.

## Docs

[Handbook](https://proamer.github.io/ORVOX/) · [Repository](https://github.com/proamer/ORVOX)

MIT © PROAMER
