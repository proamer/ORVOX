import { derive, guard, header, orvox, t, type Infer } from "@orvox/core";

const CreateUser = t.object({
  name: t.string({ min: 1, max: 100 }),
  age: t.int({ min: 0, max: 150 }),
});

const UpdateUser = t.object({
  name: t.optional(t.string({ min: 1, max: 100 })),
  age: t.optional(t.int({ min: 0, max: 150 })),
});

// Infer is exactly what reaches a handler: bodies are closed, so no stray field
// can arrive that this type does not mention.
type User = Infer<typeof CreateUser> & { id: string };

const users = new Map<string, User>();

// openapi.info describes THIS API, not the compiler that built it.
const app = orvox({
  maxRequestBodySize: 16384,
  openapi: { title: "Users API", version: "1.0.0" },
});

// Positional: this covers every route declared below it, and the compiler bakes
// the value straight into each response instead of iterating a middleware array.
app.use(header("x-powered-by", "orvox"));

app.post("/users", {
  body: CreateUser,
  handler: ({ body }) => {
    const user = { ...body, id: crypto.randomUUID() };
    users.set(user.id, user);
    return Response.json(user, { status: 201 });
  },
});

// Reading `query` is what makes the compiler emit a `new URL()` for this route.
// The three routes below never touch it, so they never pay for one.
app.get("/users", ({ query }) =>
  [...users.values()]
    .filter(user => !query.q || user.name.toLowerCase().includes(query.q.toLowerCase()))
    .slice(0, Number(query.limit ?? 50)));

app.get("/users/:id", ({ params }) => {
  const user = users.get(params.id);
  return user ? Response.json(user) : new Response("Not Found", { status: 404 });
});

app.patch("/users/:id", {
  body: UpdateUser,
  handler: ({ params, body }) => {
    const user = users.get(params.id);
    if (!user) return new Response("Not Found", { status: 404 });
    const updated = { ...user, ...body };
    users.set(user.id, updated);
    return Response.json(updated);
  },
});

app.delete("/users/:id", ({ params }) =>
  users.delete(params.id)
    ? new Response(null, { status: 204 })
    : new Response("Not Found", { status: 404 }));

// `headers` is a plain object, not a Headers instance, and only the keys named
// here are read off the request.
const requireToken = guard(({ headers }) =>
  headers.authorization === "Bearer let-me-in"
    ? undefined
    : new Response("Unauthorized", { status: 401 }));

// Whatever derive returns becomes a named local with its type carried into the
// handler context below.
const operator = derive(({ headers }) => ({ operator: headers["x-operator"] ?? "unknown" }));

// A group is a prefix plus middleware, resolved at build time. Guards short-circuit
// as an early `return` and never run for the public routes above.
app.group("/admin", { use: [requireToken, operator] }, admin => {
  admin.get("/stats", ({ operator }) => ({ users: users.size, readBy: operator }));

  admin.delete("/users", ({ operator }) => {
    const removed = users.size;
    users.clear();
    return Response.json({ removed, clearedBy: operator });
  });
});

app.onRequest(request => console.log(request.method, new URL(request.url).pathname));
app.onError(error => Response.json({ error: error.message }, { status: 500 }));
app.onStop(() => console.log(`stopped with ${users.size} user(s) in memory`));

export default app;
