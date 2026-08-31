import { derive, guard, header } from "@orvox/core";

export const branding = header("x-service", "tasks");

export const requireKey = guard(({ headers }) =>
  headers.authorization === `Bearer ${process.env.TASKS_KEY ?? "dev"}`
    ? undefined
    : new Response("Unauthorized", { status: 401 }));

export const requestId = derive(({ headers }) => ({
  requestId: headers["x-request-id"] ?? crypto.randomUUID(),
}));
