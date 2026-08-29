import { orvox } from "@orvox/core";

const app = orvox();

app.get("/", () => "hello");
app.get("/health", () => ({ ok: true }));
app.get("/users/:id", ({ params }) => ({ id: params.id }));
app.post("/users/:id", ({ params }) => ({ created: params.id }));

export default app;

