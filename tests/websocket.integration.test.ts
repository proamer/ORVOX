import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { compile } from "@orvox/compiler";

const messageFrom = (socket: WebSocket) => new Promise<string>((resolve, reject) => {
  socket.addEventListener("message", event => resolve(String(event.data)), { once: true });
  socket.addEventListener("error", () => reject(new Error("WebSocket failed.")), { once: true });
});

describe("compiled WebSocket dispatch", () => {
  let server: Bun.Server<unknown>;
  let baseUrl: URL;
  let directory: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "orvox-m5-ws-"));
    const entryPath = join(directory, "app.ts");
    await writeFile(entryPath, `
      import { orvox } from "@orvox/core"
      const app = orvox()
      app.get("/health", () => "ok")
      app.ws("/echo", { message: (ws, message) => ws.send(message) })
      app.ws("/upper", {
        open: ws => ws.send("ready"),
        message: (ws, message) => ws.send(String(message).toUpperCase())
      })
      export default app
    `, "utf8");
    const output = await compile(entryPath, { outDir: join(directory, ".orvox") });
    process.env.PORT = "0";
    ({ server } = await import(`${pathToFileURL(output.serverPath).href}?ws=${Date.now()}`));
    baseUrl = server.url;
  });

  afterAll(async () => {
    await server?.stop(true);
    delete process.env.PORT;
    await rm(directory, { recursive: true, force: true });
  });

  const socketUrl = (path: string) => {
    const url = new URL(path, baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url;
  };

  test("dispatches message handlers by compiled route id", async () => {
    const echo = new WebSocket(socketUrl("/echo"));
    await new Promise<void>((resolve, reject) => {
      echo.addEventListener("open", () => resolve(), { once: true });
      echo.addEventListener("error", () => reject(new Error("WebSocket failed.")), { once: true });
    });
    const echoed = messageFrom(echo);
    echo.send("hello");
    expect(await echoed).toBe("hello");
    echo.close();

    const upper = new WebSocket(socketUrl("/upper"));
    const ready = messageFrom(upper);
    expect(await ready).toBe("ready");
    const uppercased = messageFrom(upper);
    upper.send("orvox");
    expect(await uppercased).toBe("ORVOX");
    upper.close();
  });
});
