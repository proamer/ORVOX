# ORVOX benchmark lab

Four frameworks, four workloads, identical response bodies. The lab exists to
answer one question — does compiling the routing and validation away actually
buy throughput — and to make it cheap for anyone to check the answer.

| ID | Route | Workload |
| --- | --- | --- |
| B01 | `/plaintext` | static text |
| B02 | `/json` | static JSON |
| B03 | `/dynamic` | dynamic JSON |
| B04 | `/users/:id` | native/dynamic params |

Contenders are raw `Bun.serve`, ORVOX, Elysia, and Hono. Raw `Bun.serve` is the
ceiling, not a competitor: it is what the generated server is trying to match.

## Methodology

**Correctness gates timing.** Before any measurement, every framework must return
the exact expected body on all four routes — `"hello"` for B01, `message: "hello"`
for B02, a numeric `now` for B03, `id: "42"` for B04. A framework that answers
differently is not measured, because a faster wrong answer is not a result.
`pnpm bench:smoke` runs only this gate.

**ORVOX is measured through its output.** The run compiles
`benchmarks/orvox/src/app.ts` first and benchmarks
`benchmarks/orvox/.orvox/server.generated.ts` — the artifact a user deploys, not
the source they write. There is no ORVOX code in the process being measured.

**Every measurement gets a fresh process.** Each framework × workload × iteration
spawns a new server on a newly probed port and kills it afterwards. Nothing is
reused between measurements, so a warmed JIT or a leaked connection pool cannot
carry an advantage forward.

**Framework order is randomized per iteration.** Thermal drift and background load
climb over the length of a run; a fixed order would hand that cost to whichever
framework always went last.

**Each measurement is preceded by a discarded warm-up** — 2 seconds at concurrency
64, thrown away, then the measured run.

**Defaults** are 10 iterations, 20 seconds, concurrency 256, overridable with
`BENCH_ITERATIONS`, `BENCH_DURATION`, and `BENCH_CONCURRENCY`.

**What is recorded.** Raw `oha` JSON for every measurement plus platform, kernel
release, architecture, CPU model, logical CPU count, total memory, and the Bun
version, written to `benchmarks/results/<timestamp>.json`. The summary is derived
from that file and never replaces it.

## Reading the numbers

`pnpm bench:report` reduces each (workload, framework) group to two figures:

- **Median req/s** — the median of `summary.requestsPerSec` across iterations.
- **Spread** — `(max − min) / median × 100`.

Spread is the full range, not a standard deviation. One bad iteration is meant to
show up rather than average away, so treat it as a confidence gate:

| Spread | What the row is worth |
| --- | --- |
| under 5% | trustworthy |
| 5–10% | usable; only differences larger than the spread mean anything |
| 10–20% | comparable only where frameworks are far apart |
| over 20% | noise — rerun, do not publish |

Two frameworks whose medians differ by less than either one's spread are tied.
Publish medians and spread together; a median without its spread is a claim with
its evidence removed.

## Published results

Full default configuration — 10 iterations, 20 seconds, concurrency 256, 160
measurements — from the scheduled CI run on 2026-08-31
([run 33350712418](https://github.com/proamer/ORVOX/actions/runs/33350712418)).
The raw record is committed at
[`published/2026-08-31-ubuntu-latest.json`](published/2026-08-31-ubuntu-latest.json),
because CI artifacts expire and a published number without its evidence is
worth nothing.

`ubuntu-latest` · Linux 6.17.0-1022-azure · Xeon Platinum 8573C · 4 vCPU · 16 GB
· Bun 1.4.0 · ORVOX 0.1.0-alpha.1 · Elysia 1.4.30 · Hono 4.13.5

| Workload | bun-native | ORVOX | Elysia | Hono |
| --- | ---: | ---: | ---: | ---: |
| B01 plaintext | 190510 <sub>2.70%</sub> | **189953** <sub>1.75%</sub> | 170582 <sub>4.72%</sub> | 155635 <sub>6.07%</sub> |
| B02 json | 188773 <sub>3.34%</sub> | **190108** <sub>1.36%</sub> | 160590 <sub>6.84%</sub> | 142272 <sub>3.54%</sub> |
| B03 dynamic | 161305 <sub>6.44%</sub> | **163037** <sub>4.19%</sub> | 159322 <sub>6.44%</sub> | 137369 <sub>3.48%</sub> |
| B04 params | 163638 <sub>8.49%</sub> | **163134** <sub>4.69%</sub> | 158709 <sub>5.74%</sub> | 136547 <sub>6.02%</sub> |

Median req/s, with spread beneath. Applying the rule above — a gap smaller than
either spread is a tie — the run says three things:

- **ORVOX matches raw `Bun.serve` everywhere.** The gap runs from −0.3% to +1.1% and never leaves the noise on any workload. That is the whole thesis: the ergonomics cost nothing, because by request time there is no framework left to pay for.
- **ORVOX is ahead of Hono on all four**, by 18.7% to 33.6%, comfortably outside the spread.
- **Against Elysia the answer splits.** ORVOX leads by 11.4% and 18.4% on the static workloads, and ties on the dynamic two. That is the shape you would expect: eliminating per-request framework work pays most where the handler does least, and once real work dominates the field converges.

ORVOX also has the lowest spread on three of four workloads. Nothing is matching
a route, walking a schema, or iterating middleware per request, so there is less
to jitter.

Numbers on a shared runner are not a hardware claim. What the run supports is the
comparison, since all four were measured in one sitting under one set of
conditions.

## Running it

```bash
pnpm bench:smoke
```

```bash
pnpm bench
```

```bash
pnpm bench:report
```

`oha` must be on `PATH` — [install it](https://github.com/hatoo/oha) first. Close
everything else, keep the machine on mains power, and do not use it during the
run. A full default run takes roughly an hour.

**The canonical run is CI, not a laptop.** The
[benchmark workflow](../.github/workflows/benchmark.yml) runs the full default
configuration on `ubuntu-latest` and uploads both the raw JSON and the summary,
so results are reproducible by anyone with a fork rather than trusted on one
maintainer's word.

## What invalidates a run

- **Anything else using the machine.** A browser, a sync client, or an indexer competing for cores lands squarely in the spread column.
- **Windows loopback.** It is markedly slower than Linux for this traffic, so Windows numbers understate every framework and must never be compared against figures published from Linux.
- **Shared CI runners.** Absolute throughput on a hosted runner is low and noisy neighbours are real. The relative comparison survives — all four frameworks are measured in the same run under the same conditions — but the absolute req/s is not a hardware claim.
- **Comparing across machines.** Numbers are only meaningful against the other frameworks in the same file.
