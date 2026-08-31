import { orvox, t } from "@orvox/core";

const app = orvox();

const User = t.object({ id: t.string(), age: t.int() });

// A declared response constrains the handler, so the document and the code
// cannot drift apart without the build saying so.
app.get("/me", {
  response: User,
  handler: () => ({ id: "a", age: 1 }),
});

// Returning a Response directly stays legal -- statuses and headers are not
// something a body schema can describe.
app.get("/maybe", {
  response: User,
  handler: () => new Response(null, { status: 204 }),
});

// Overload resolution reports these on the call, not on the handler property.

// @ts-expect-error age is declared an integer, not a string
app.get("/wrong-type", {
  response: User,
  handler: () => ({ id: "a", age: "1" }),
});

// @ts-expect-error the declared response requires age
app.get("/missing-field", {
  response: User,
  handler: () => ({ id: "a" }),
});

// Known gap: an extra field is NOT caught. Excess-property checking needs a
// fresh literal assigned to a single type, and the contextual type here is a
// union with Response, which drops that freshness. Missing and mistyped fields
// are still caught, which is what drift between the document and the code
// actually looks like; if this ever needs closing it wants a runtime check, and
// that is a throughput decision rather than a typing one.
app.get("/extra-field", {
  response: User,
  handler: () => ({ id: "a", age: 1, extra: true }),
});

// Without a declaration the return type is still whatever the handler says.
app.get("/free", () => ({ anything: [1, 2, 3] }));

export default app;
