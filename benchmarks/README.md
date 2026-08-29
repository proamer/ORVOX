# ORVOX benchmark lab

B01–B04 use identical response bodies across raw Bun, ORVOX, Elysia, and Hono:

| ID | Route | Workload |
| --- | --- | --- |
| B01 | `/plaintext` | static text |
| B02 | `/json` | static JSON |
| B03 | `/dynamic` | dynamic JSON |
| B04 | `/users/:id` | native/dynamic params |

Run correctness smoke:

```powershell
pnpm bench:smoke
```

Install `oha`, isolate the machine from background load, then run the default 10 measured iterations. Every measurement gets a 2-second warm-up and framework order is randomized.

```powershell
pnpm bench
```

Optional environment controls are `BENCH_ITERATIONS`, `BENCH_DURATION`, and `BENCH_CONCURRENCY`. Raw `oha` JSON plus runtime/machine metadata is written under `benchmarks/results/`; publish medians and spread from those records, never a best run.

