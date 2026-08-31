import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const destination = join(root, "artifacts");
const { version } = await Bun.file(join(root, "package.json")).json();
const packages = ["schema", "core", "compiler", "cli"];
const pnpm = Bun.which("pnpm");

if (!pnpm) throw new Error("pnpm is required to pack ORVOX.");
await mkdir(destination, { recursive: true });

for (const name of packages) {
  const tarball = join(destination, `orvox-${name}-${version}.tgz`);
  await rm(tarball, { force: true });
  const child = Bun.spawn(
    [pnpm, "pack", "--pack-destination", destination],
    {
      cwd: join(root, "packages", name),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim());
  if (!(await Bun.file(tarball).exists())) {
    throw new Error(`pnpm did not produce ${tarball}.`);
  }
  console.log(tarball);
}
