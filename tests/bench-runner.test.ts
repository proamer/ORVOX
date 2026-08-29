import { expect, test } from "bun:test";
import { join } from "node:path";

test("benchmark smoke command executes B01-B04 for every framework", async () => {
  const root = join(import.meta.dir, "..");
  const child = Bun.spawn(
    [process.execPath, join(root, "scripts", "bench.ts"), "--smoke"],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );

  expect(await child.exited).toBe(0);
  expect(await new Response(child.stdout).text()).toContain(
    "4/4 frameworks passed B01-B04 smoke",
  );
});

