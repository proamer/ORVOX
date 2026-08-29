#!/usr/bin/env bun

import { watch } from "node:fs";
import { dirname, resolve } from "node:path";
import { CompileError, compile } from "@orvox/compiler";

const usage = "Usage: orvox <build|inspect|dev> [entry] [--outdir path]";

const argumentsFor = (args: string[]) => {
  const command = args[0];
  if (!command || !["build", "inspect", "dev"].includes(command)) {
    throw new Error(usage);
  }
  const outIndex = args.indexOf("--outdir");
  if (outIndex >= 0 && !args[outIndex + 1]) {
    throw new Error("--outdir requires a path.");
  }
  return {
    command,
    entry: args[1]?.startsWith("--") ? "src/app.ts" : (args[1] ?? "src/app.ts"),
    outDir: outIndex >= 0 ? args[outIndex + 1] : ".orvox",
  };
};

const build = async (entry: string, outDir: string) => {
  const result = await compile(entry, { outDir });
  const count = result.manifest.routes.length;
  console.log(`Built ${count} route${count === 1 ? "" : "s"} → ${result.serverPath}`);
  return result;
};

const dev = async (entry: string, outDir: string) => {
  const absoluteEntry = resolve(entry);
  const absoluteOutDir = resolve(outDir);
  let child: Bun.Subprocess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const restart = async () => {
    try {
      const result = await build(absoluteEntry, absoluteOutDir);
      child?.kill();
      await child?.exited;
      child = Bun.spawn([process.execPath, result.serverPath], {
        cwd: process.cwd(),
        env: process.env,
        stdout: "inherit",
        stderr: "inherit",
      });
    } catch (error) {
      console.error(formatError(error));
    }
  };

  await restart();
  const root = dirname(absoluteEntry);
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (!filename?.endsWith(".ts")) return;
    if (resolve(root, filename).startsWith(absoluteOutDir)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(restart, 50);
  });
  const stop = () => {
    watcher.close();
    child?.kill();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await new Promise<void>(resolveDone => watcher.once("close", resolveDone));
};

const formatError = (error: unknown) =>
  error instanceof CompileError
    ? `${error.code}: ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);

async function main() {
  const { command, entry, outDir } = argumentsFor(process.argv.slice(2));
  if (command === "build") {
    await build(entry, outDir);
    return;
  }
  if (command === "inspect") {
    const result = await build(entry, outDir);
    console.log(JSON.stringify({ manifest: result.manifest, analysis: result.analysis, openapi: result.openapi }, null, 2));
    return;
  }
  await dev(entry, outDir);
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(formatError(error));
    process.exitCode = 1;
  }
}
