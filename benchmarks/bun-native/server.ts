const hostname = "127.0.0.1";
const port = Number(process.env.PORT ?? 3001);

export const server = Bun.serve({
  hostname,
  port,
  routes: {
    "/plaintext": new Response("hello"),
    "/json": Response.json({ message: "hello" }),
    "/dynamic": () => Response.json({ now: Date.now() }),
    "/users/:id": req => Response.json({ id: req.params.id }),
  },
  fetch: () => new Response("Not Found", { status: 404 }),
});

if (import.meta.main) console.log(`READY ${server.url}`);

