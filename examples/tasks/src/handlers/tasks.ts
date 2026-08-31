import { q, type Row } from "../db.ts";
import type { Task } from "../schemas.ts";

// A file-local helper the handlers below lean on. If inlining a handler cannot
// bring this along, splitting handlers out is not really supported.
const present = (row: Row): Task => ({
  id: row.id,
  title: row.title,
  state: row.state as Task["state"],
  ...(row.points === null ? {} : { points: row.points }),
  createdAt: row.created_at,
});

const notFound = () => new Response("Not Found", { status: 404 });

export const listTasks = ({ query }: any) =>
  q.page.all(query.state ?? "", query.limit ?? 20, query.offset ?? 0).map(present);

export const createTask = ({ body }: any) =>
  Response.json(present(q.insert.get(body.title, "todo", body.points ?? null, Date.now())!), {
    status: 201,
  });

export const getTask = ({ params }: any) => {
  const row = q.byId.get(params.id);
  return row ? present(row) : notFound();
};

export const removeTask = ({ params }: any) => {
  if (!q.byId.get(params.id)) return notFound();
  q.remove.run(params.id);
  return new Response(null, { status: 204 });
};
