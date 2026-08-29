import { Elysia } from "elysia";

const port = Number(process.env.PORT ?? 3002);

export const app = new Elysia()
  .get("/plaintext", () => "hello")
  .get("/json", () => ({ message: "hello" }))
  .get("/dynamic", () => ({ now: Date.now() }))
  .get("/users/:id", ({ params }) => ({ id: params.id }))
  .listen({ hostname: "127.0.0.1", port });

if (import.meta.main) console.log(`READY http://127.0.0.1:${port}/`);

