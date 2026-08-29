import { header, orvox, t } from "@orvox/core";

type User = { id: string; name: string; age: number };
const users = new Map<string, User>();
const CreateUser = t.object({
  name: t.string({ min: 1, max: 100 }),
  age: t.int({ min: 0, max: 150 }),
});
const UpdateUser = t.object({
  name: t.optional(t.string({ min: 1, max: 100 })),
  age: t.optional(t.int({ min: 0, max: 150 })),
});

const app = orvox({ maxRequestBodySize: 16384 });
app.use(header("x-powered-by", "orvox"));

app.post("/users", {
  body: CreateUser,
  handler: ({ body }) => {
    const user = { ...body, id: crypto.randomUUID() };
    users.set(user.id, user);
    return Response.json(user, { status: 201 });
  },
});

app.get("/users", () => [...users.values()]);

app.get("/users/:id", ({ params }) => {
  const user = users.get(params.id);
  return user
    ? Response.json(user)
    : new Response("Not Found", { status: 404 });
});

app.patch("/users/:id", {
  body: UpdateUser,
  handler: ({ params, body }) => {
    const user = users.get(params.id);
    if (!user) return new Response("Not Found", { status: 404 });
    if (body.name !== undefined) user.name = body.name;
    if (body.age !== undefined) user.age = body.age;
    return Response.json(user);
  },
});

app.delete("/users/:id", ({ params }) => {
  if (!users.delete(params.id)) return new Response("Not Found", { status: 404 });
  return new Response(null, { status: 204 });
});

export default app;
