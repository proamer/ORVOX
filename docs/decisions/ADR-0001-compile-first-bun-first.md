# ADR-0001: Compile-first and Bun-first

- Status: accepted
- Date: 2026-08-29

## Decision

ORVOX v0.x targets Bun only and lowers static route declarations into native `Bun.serve({ routes })` source before deployment.

## Why

Supporting several runtimes now would force a shared dispatcher into the hot path before the performance thesis is proven. Bun already provides native path routing, typed params, static responses, and HTTP primitives that the compiler can target directly.

## Consequences

- Route declarations must be statically analyzable.
- Generated source is a reviewed and tested product artifact.
- Node and edge-runtime adapters remain out of scope until the Bun baseline is measured and stable.

