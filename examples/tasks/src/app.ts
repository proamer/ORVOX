import { orvox } from "@orvox/core";
import { ListQuery, Move, NewTask, Task, TaskId } from "./schemas.ts";
import { branding, requestId, requireKey } from "./middleware.ts";
import { createTask, getTask, listTasks, removeTask } from "./handlers/tasks.ts";
import { db, q } from "./db.ts";

const API = "/v1";

const app = orvox();
app.use(branding);

app.get("/health", { response: Task, handler: () => ({}) as any });

app.group(API, { use: [requireKey, requestId] }, v1 => {
  v1.get("/tasks", { query: ListQuery, handler: listTasks });
  v1.post("/tasks", { body: NewTask, handler: createTask });

  v1.group("/tasks/:id", { use: [] }, one => {
    one.get("", { params: TaskId, handler: getTask });
    one.delete("", { params: TaskId, handler: removeTask });

    one.post("/move", {
      params: TaskId,
      body: Move,
      handler: ({ params, body, requestId: rid }) => {
        if (!q.byId.get(params.id)) return new Response("Not Found", { status: 404 });
        const row = q.setState.get(body.to, params.id)!;
        return { id: row.id, state: row.state, movedBy: rid };
      },
    });
  });
});

app.onStop(() => db.close());

export default app;
