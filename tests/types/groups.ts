import { derive, guard, orvox } from "@orvox/core";

const app = orvox();

const token = guard(({ headers }) =>
  headers.authorization ? undefined : new Response("Unauthorized", { status: 401 }));

const who = derive(({ headers }) => ({ operator: headers["x-operator"] ?? "anon" }));
const tenant = derive(() => ({ tenant: 1 }));

app.group("/api", { use: [tenant] }, api => {
  api.get("/ping", ({ tenant: t }) => {
    const outer: number = t;
    return outer;
  });

  api.group("/v2", { use: [token, who] }, v2 => {
    // Both the outer group's derive and this one's are in scope, and the path
    // has accumulated through every prefix.
    v2.get("/whoami/:id", ({ params, tenant: t, operator }) => {
      const id: string = params.id;
      const outer: number = t;
      const inner: string = operator;
      return { id, outer, inner };
    });

    // @ts-expect-error a sibling group's extension is not in scope here
    v2.get("/nope", ({ missing }) => missing);
  });
});

export default app;
