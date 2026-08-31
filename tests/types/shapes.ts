import { orvox, t, type Infer } from "@orvox/core";

const app = orvox();

const Reading = t.object({
  celsius: t.number({ min: -273.15 }),
  unit: t.literal("metric"),
  status: t.enum(["ok", "stale"]),
});

type Reading = Infer<typeof Reading>;

const reading: Reading = { celsius: 21.5, unit: "metric", status: "ok" };

// @ts-expect-error a literal narrows to exactly its own value
const wrongLiteral: Reading["unit"] = "imperial";

// @ts-expect-error an enum narrows to its listed values
const wrongEnum: Reading["status"] = "missing";

const Event = t.union("type", [
  t.object({ type: t.literal("click"), x: t.int(), y: t.int() }),
  t.object({ type: t.literal("key"), code: t.string() }),
]);

// The tag discriminates, so narrowing on it reaches each branch's own fields.
const describe = (event: Infer<typeof Event>) =>
  event.type === "click" ? event.x + event.y : event.code.length;

app.post("/event", { body: Event, handler: ({ body }) => describe(body) });

app.post("/reading", {
  body: Reading,
  response: t.object({ celsius: t.number() }),
  handler: ({ body }) => ({ celsius: body.celsius }),
});

export default app;
export { reading, wrongLiteral, wrongEnum };
