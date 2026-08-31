import { t, type Infer } from "@orvox/core";

export const State = t.enum(["todo", "doing", "done"]);

export const NewTask = t.object({
  title: t.string({ min: 1, max: 200 }),
  points: t.optional(t.int({ min: 1, max: 21 })),
});

export const Move = t.union("to", [
  t.object({ to: t.literal("doing"), assignee: t.string({ min: 1 }) }),
  t.object({ to: t.literal("done"), minutes: t.int({ min: 0 }) }),
  t.object({ to: t.literal("todo") }),
]);

export const Task = t.object({
  id: t.int(),
  title: t.string(),
  state: State,
  points: t.optional(t.int()),
  createdAt: t.int(),
});

export const ListQuery = t.object({
  state: t.optional(State),
  limit: t.optional(t.int({ min: 1, max: 100 })),
  offset: t.optional(t.int({ min: 0 })),
});

export const TaskId = t.object({ id: t.int({ min: 1 }) });

export type Task = Infer<typeof Task>;
