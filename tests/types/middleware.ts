import { derive, guard, orvox } from "@orvox/core";

const auth = derive(({ headers }) => ({
  auth: { sub: headers.authorization ?? "anonymous" },
}));

const app = orvox();
app.get("/private", {
  use: [auth, guard(({ auth }) => auth.sub === "anonymous"
    ? new Response("Unauthorized", { status: 401 })
    : undefined)] as const,
  handler: ({ auth }) => {
    const subject: string = auth.sub;
    return { subject };
  },
});

app.group("/orgs", { use: derive(() => ({ tenantId: "oga" })) }, group => {
  group.get("/:id", ({ tenantId, params }) => {
    const tenant: string = tenantId;
    return { tenant, id: params.id };
  });
});

const chained = orvox().use(derive(() => ({ requestId: crypto.randomUUID() })));
chained.get("/request", ({ requestId }) => requestId);

app.get("/plain", context => {
  // @ts-expect-error derived fields exist only where middleware is declared
  context.auth;
  return "ok";
});
