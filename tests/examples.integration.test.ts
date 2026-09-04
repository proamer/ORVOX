import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "@orvox/compiler";

/**
 * Every bug in the 0.5.x line was found by building an example and calling it:
 * a template literal spliced out of the wrong file, a helper left behind, a body
 * read twice. All of it compiled cleanly, so compiling is not the check --
 * answering is. The examples are exercised here rather than trusted.
 */
const root = join(import.meta.dir, "..");

let directory: string | undefined;
let server: Bun.Server<unknown> | undefined;

afterEach(async () => {
  await server?.stop(true);
  server = undefined;
  delete process.env.PORT;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

const start = async (example: string) => {
  // Built inside the workspace: an example that keeps a schema alive for a
  // `type X = Infer<typeof X>` still imports @orvox/core, which only resolves
  // from here.
  directory = await mkdtemp(join(root, `.orvox-example-${example}-`));
  const result = await compile(join(root, "examples", example, "src", "app.ts"), {
    outDir: directory,
  });
  process.env.PORT = "0";
  ({ server } = await import(`${pathToFileURL(result.serverPath).href}?e=${Date.now()}`));
  return server!.url;
};

const send = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

test("crud serves what it declares", async () => {
  const url = await start("crud");

  const created = await fetch(new URL("/users", url), send({ name: "Amp", age: 35 }));
  expect(created.status).toBe(201);
  const user = await created.json() as { id: string };

  expect(await (await fetch(new URL(`/users/${user.id}`, url))).json())
    .toMatchObject({ name: "Amp", age: 35 });
  expect((await fetch(new URL("/users", url), send({ name: "", age: 1 }))).status).toBe(400);
  expect((await fetch(new URL("/admin/stats", url))).status).toBe(401);
});

test("links resolves aliases and redirects", async () => {
  const url = await start("links");
  const key = { authorization: "Bearer dev-key" };

  const made = await fetch(new URL("/api/links", url), send(
    { kind: "url", target: "https://example.com/a" },
    key,
  ));
  expect(made.status).toBe(201);
  const { code } = await made.json() as { code: string };

  const redirect = await fetch(new URL(`/r/${code}`, url), { redirect: "manual" });
  expect([redirect.status, redirect.headers.get("location")])
    .toEqual([302, "https://example.com/a"]);

  // the tag picks the branch, and the failure is reported against it
  const bad = await fetch(new URL("/api/links", url), send({ kind: "scroll" }, key));
  expect(bad.status).toBe(400);
  expect((await bad.json()).issues[0].path).toBe("$.kind");

  expect((await fetch(new URL("/api/links", url))).status).toBe(401);
});

test("tasks runs handlers that live in another file", async () => {
  const url = await start("tasks");
  const key = { authorization: "Bearer dev" };

  // present() and notFound() are file-local helpers in handlers/tasks.ts; a 500
  // here means they were not hoisted into the output
  const created = await fetch(new URL("/v1/tasks", url), send({ title: "ship it", points: 5 }, key));
  expect(created.status).toBe(201);
  expect(await created.json()).toMatchObject({ id: 1, title: "ship it", state: "todo" });

  expect(await (await fetch(new URL("/v1/tasks/1", url), { headers: key })).json())
    .toMatchObject({ id: 1 });
  expect((await fetch(new URL("/v1/tasks/999", url), { headers: key })).status).toBe(404);

  const moved = await fetch(new URL("/v1/tasks/1/move", url), send(
    { to: "doing", assignee: "amp" },
    key,
  ));
  expect(await moved.json()).toMatchObject({ state: "doing" });

  // the union's other branch requires a different field
  const wrong = await fetch(new URL("/v1/tasks/1/move", url), send({ to: "done" }, key));
  expect((await wrong.json()).issues[0]).toMatchObject({ path: "$.minutes", code: "required" });
});

test("media handles bytes, a stream, and a socket", async () => {
  const url = await start("media");

  const uploaded = await fetch(new URL("/clips", url), {
    method: "POST",
    body: new Uint8Array([1, 2, 3, 4, 5]),
  });
  const clip = await uploaded.json() as { id: string; bytes: number };
  expect([uploaded.status, clip.bytes]).toEqual([201, 5]);

  const downloaded = await fetch(new URL(`/clips/${clip.id}`, url));
  expect((await downloaded.arrayBuffer()).byteLength).toBe(5);
  expect((await fetch(new URL("/clips/missing", url))).status).toBe(404);

  expect(await (await fetch(new URL("/countdown?from=3", url))).text()).toBe("3\n2\n1\n");
  expect((await fetch(new URL("/countdown?from=99", url))).status).toBe(400);

  const events = await fetch(new URL("/events", url));
  expect(events.headers.get("content-type")).toBe("text/event-stream");
  expect(await events.text()).toContain("data: tick 3");

  const socket = new WebSocket(`${url.href.replace("http", "ws")}echo`);
  const seen: string[] = [];
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error("websocket timed out")), 5000);
    socket.addEventListener("open", () => socket.send("hi"));
    socket.addEventListener("message", event => {
      seen.push(String(event.data));
      if (seen.length === 2) {
        clearTimeout(timer);
        socket.close();
        done();
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      fail(new Error("websocket errored"));
    });
  });
  expect(seen).toEqual(["ready", "echo:hi"]);
});

test("every example compiles to a file that type-checks on its own", async () => {
  // A generated server that runs but does not type-check is only half an
  // artifact -- the whole point is that you can read and check the output.
  for (const example of ["crud", "links", "tasks", "media"]) {
    directory = await mkdtemp(join(root, `.orvox-types-${example}-`));
    try {
      const result = await compile(join(root, "examples", example, "src", "app.ts"), {
        outDir: directory,
      });
      const check = Bun.spawnSync([
        process.execPath, "x", "tsc",
        "--noEmit", "--skipLibCheck", "--strict", "--allowImportingTsExtensions",
        "--target", "esnext", "--module", "esnext", "--moduleResolution", "bundler",
        "--types", "bun",
        result.serverPath,
      ], { cwd: root });
      const output = new TextDecoder().decode(check.stdout) + new TextDecoder().decode(check.stderr);
      expect([example, output.trim()]).toEqual([example, ""]);
    } finally {
      await rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  }
}, 120_000);
