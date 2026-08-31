import { orvox, t } from "@orvox/core";

const app = orvox();

const Search = t.object({
  q: t.string({ min: 1 }),
  page: t.optional(t.int()),
  exact: t.optional(t.boolean()),
});

// A declared schema converts as well as narrows: these arrive parsed, not as
// the strings the wire carried.
app.get("/search", {
  query: Search,
  handler: ({ query }) => {
    const q: string = query.q;
    const page: number | undefined = query.page;
    const exact: boolean | undefined = query.exact;

    // @ts-expect-error page is a number once a schema declares it
    const stillAString: string = query.page;

    // @ts-expect-error undeclared parameters are not on the narrowed type
    query.utm_source;

    return { q, page, exact, stillAString };
  },
});

// Without a schema the raw string map is what the handler gets.
app.get("/raw", ({ query }) => {
  const value: string | undefined = query.anything;

  // @ts-expect-error nothing is parsed without a schema to declare it
  const parsed: number = query.anything;

  return { value, parsed };
});

// query composes with body and middleware rather than excluding them.
app.post("/search", {
  body: t.object({ note: t.string() }),
  query: Search,
  handler: ({ body, query }) => ({ note: body.note, page: query.page }),
});

// A params schema converts path segments the same way, and composes with query.
app.get("/users/:id/posts/:slug", {
  params: t.object({ id: t.int(), slug: t.string() }),
  query: Search,
  handler: ({ params, query }) => {
    const id: number = params.id;
    const slug: string = params.slug;

    // @ts-expect-error id is a number once a schema declares it
    const stillAString: string = params.id;

    return { id, slug, page: query.page, stillAString };
  },
});

// Without a params schema every segment is still a string.
app.get("/plain/:id", ({ params }) => {
  const id: string = params.id;
  // @ts-expect-error nothing is parsed without a schema to declare it
  const parsed: number = params.id;
  return { id, parsed };
});

export default app;
