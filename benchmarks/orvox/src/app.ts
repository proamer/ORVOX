import { orvox } from "@orvox/core";

const app = orvox();

app.get("/plaintext", () => "hello");
app.get("/json", () => ({ message: "hello" }));
app.get("/dynamic", () => ({ now: Date.now() }));
app.get("/users/:id", ({ params }) => ({ id: params.id }));

export default app;

