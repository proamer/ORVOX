import { Hono } from "hono";

const app = new Hono();

app.get("/plaintext", context => context.text("hello"));
app.get("/json", context => context.json({ message: "hello" }));
app.get("/dynamic", context => context.json({ now: Date.now() }));
app.get("/users/:id", context => context.json({ id: context.req.param("id") }));

export const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 3003),
  fetch: app.fetch,
});

if (import.meta.main) console.log(`READY ${server.url}`);

