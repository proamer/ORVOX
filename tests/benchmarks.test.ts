import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { compile } from "@orvox/compiler";

const root = join(import.meta.dir, "..");
const servers = [
  ["bun-native", join(root, "benchmarks", "bun-native", "server.ts")],
  [
    "orvox",
    join(root, "benchmarks", "orvox", ".orvox", "server.generated.ts"),
  ],
  ["elysia", join(root, "benchmarks", "elysia", "server.ts")],
  ["hono", join(root, "benchmarks", "hono", "server.ts")],
] as const;

const children: Bun.Subprocess[] = [];

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
      const response = await fetch(new URL("/plaintext", url));
      if (response.ok) return;
    } catch {}
    await Bun.sleep(20);
  }
  throw new Error(`Benchmark server did not start at ${url}.`);
};

beforeAll(async () => {
  const directory = join(root, "benchmarks", "orvox");
  await compile(join(directory, "src", "app.ts"), {
    outDir: join(directory, ".orvox"),
  });
});

afterAll(async () => {
  for (const child of children) child.kill();
  await Promise.all(children.map(child => child.exited));
});

describe("B01-B04 benchmark parity", () => {
  for (const [name, file] of servers) {
    test(`${name} serves the same workloads`, async () => {
      const port = await nextPort();
      const url = new URL(`http://127.0.0.1:${port}`);
      const child = Bun.spawn([process.execPath, file], {
        cwd: root,
        env: { ...process.env, PORT: String(port) },
        stdout: "pipe",
        stderr: "pipe",
      });
      children.push(child);
      await waitUntilReady(url, child);

      const plaintext = await fetch(new URL("/plaintext", url));
      const json = await fetch(new URL("/json", url));
      const dynamic = await fetch(new URL("/dynamic", url));
      const params = await fetch(new URL("/users/42", url));

      expect(await plaintext.text()).toBe("hello");
      expect(await json.json()).toEqual({ message: "hello" });
      expect(typeof (await dynamic.json()).now).toBe("number");
      expect(await params.json()).toEqual({ id: "42" });
    });
  }
});

