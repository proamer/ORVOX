import { mkdir, readFile, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { compile } from "@orvox/compiler";

const root = join(import.meta.dir, "..");
const frameworks = [
  { name: "bun-native", file: join(root, "benchmarks", "bun-native", "server.ts") },
  {
    name: "orvox",
    file: join(root, "benchmarks", "orvox", ".orvox", "server.generated.ts"),
  },
  { name: "elysia", file: join(root, "benchmarks", "elysia", "server.ts") },
  { name: "hono", file: join(root, "benchmarks", "hono", "server.ts") },
] as const;
const workloads = [
  { id: "B01", path: "/plaintext" },
  { id: "B02", path: "/json" },
  { id: "B03", path: "/dynamic" },
  { id: "B04", path: "/users/42" },
] as const;

const prepare = () => {
  const directory = join(root, "benchmarks", "orvox");
  return compile(join(directory, "src", "app.ts"), {
    outDir: join(directory, ".orvox"),
  });
};

const nextPort = async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  return port;
};

const waitUntilReady = async (url: URL, child: Bun.Subprocess) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error("Benchmark server exited early.");
    try {
      if ((await fetch(new URL("/plaintext", url))).ok) return;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error(`Benchmark server did not start at ${url}.`);
};

const start = async (framework: (typeof frameworks)[number]) => {
  const port = await nextPort();
  const url = new URL(`http://127.0.0.1:${port}`);
  const child = Bun.spawn([process.execPath, framework.file], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  await waitUntilReady(url, child);
  return { child, url };
};

const stop = async (child: Bun.Subprocess) => {
  child.kill();
  await child.exited;
};

const verifyWorkloads = async (url: URL) => {
  const plaintext = await fetch(new URL("/plaintext", url));
  const json = await fetch(new URL("/json", url));
  const dynamic = await fetch(new URL("/dynamic", url));
  const params = await fetch(new URL("/users/42", url));
  if ((await plaintext.text()) !== "hello") throw new Error("B01 response mismatch.");
  if ((await json.json()).message !== "hello") throw new Error("B02 response mismatch.");
  if (typeof (await dynamic.json()).now !== "number") {
    throw new Error("B03 response mismatch.");
  }
  if ((await params.json()).id !== "42") throw new Error("B04 response mismatch.");
};

const smoke = async () => {
  await prepare();
  let passed = 0;
  for (const framework of frameworks) {
    const server = await start(framework);
    try {
      await verifyWorkloads(server.url);
      passed++;
      console.log(`PASS ${framework.name}`);
    } finally {
      await stop(server.child);
    }
  }
  console.log(`${passed}/${frameworks.length} frameworks passed B01-B04 smoke`);
};

const shuffle = <T>(values: readonly T[]) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const next = crypto.getRandomValues(new Uint32Array(1))[0]! % (index + 1);
    [result[index], result[next]] = [result[next]!, result[index]!];
  }
  return result;
};

const runOha = async (
  executable: string,
  url: URL,
  duration: string,
  concurrency: number,
) => {
  const child = Bun.spawn(
    [
      executable,
      "-z",
      duration,
      "-c",
      String(concurrency),
      "--output-format",
      "json",
      url.href,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`oha failed: ${stderr.trim()}`);
  return JSON.parse(stdout);
};

const benchmark = async () => {
  const oha = Bun.which("oha");
  if (!oha) {
    throw new Error("oha is required for full benchmarks; install it or run --smoke.");
  }
  await prepare();
  const iterations = Number(process.env.BENCH_ITERATIONS ?? 10);
  const duration = process.env.BENCH_DURATION ?? "20s";
  const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 256);
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error("BENCH_ITERATIONS must be a positive integer.");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("BENCH_CONCURRENCY must be a positive integer.");
  }

  const results: unknown[] = [];
  for (const workload of workloads) {
    for (let iteration = 1; iteration <= iterations; iteration++) {
      for (const framework of shuffle(frameworks)) {
        const server = await start(framework);
        try {
          await runOha(oha, new URL(workload.path, server.url), "2s", 64);
          const measurement = await runOha(
            oha,
            new URL(workload.path, server.url),
            duration,
            concurrency,
          );
          results.push({
            workload: workload.id,
            framework: framework.name,
            iteration,
            measurement,
          });
          console.log(`${workload.id} ${iteration}/${iterations} ${framework.name}`);
        } finally {
          await stop(server.child);
        }
      }
    }
  }

  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const report = {
    generatedAt: new Date().toISOString(),
    configuration: { iterations, duration, concurrency },
    machine: {
      platform: platform(),
      release: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemoryBytes: totalmem(),
      bun: Bun.version,
    },
    versions: {
      orvox: packageJson.version,
      elysia: packageJson.devDependencies.elysia,
      hono: packageJson.devDependencies.hono,
    },
    results,
  };
  const outDir = join(root, "benchmarks", "results");
  const filename = `${report.generatedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`;
  await mkdir(outDir, { recursive: true });
  const output = join(outDir, filename);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Report: ${output}`);
};

try {
  if (process.argv.includes("--smoke")) await smoke();
  else await benchmark();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

