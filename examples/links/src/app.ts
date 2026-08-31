import { Database } from "bun:sqlite";
import { derive, guard, header, orvox, t, type Infer } from "@orvox/core";

// Module-level setup the compiler has to carry through untouched: a real
// connection, real prepared statements, real helpers.
const db = new Database(process.env.LINKS_DB ?? ":memory:", { create: true });
db.exec(`
  CREATE TABLE IF NOT EXISTS links (
    code       TEXT PRIMARY KEY,
    target     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    expires_at INTEGER,
    hits       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
`);

type Row = {
  code: string;
  target: string;
  kind: string;
  expires_at: number | null;
  hits: number;
  created_at: number;
};

const statements = {
  insert: db.query<void, [string, string, string, number | null, number]>(
    "INSERT INTO links (code, target, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
  ),
  byCode: db.query<Row, [string]>("SELECT * FROM links WHERE code = ?"),
  page: db.query<Row, [string, number]>(
    "SELECT * FROM links WHERE code > ? ORDER BY code LIMIT ?",
  ),
  hit: db.query<void, [string]>("UPDATE links SET hits = hits + 1 WHERE code = ?"),
  remove: db.query<void, [string]>("DELETE FROM links WHERE code = ?"),
  count: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM links"),
};

const CODE = "abcdefghijkmnpqrstuvwxyz23456789";
const newCode = () =>
  Array.from({ length: 7 }, () => CODE[Math.floor(Math.random() * CODE.length)]).join("");

const live = (row: Row) => row.expires_at === null || row.expires_at > Date.now();

// A link is either an external URL or a pointer at another code, and the two
// carry different fields. The tag is what the compiler switches on.
const NewLink = t.union("kind", [
  t.object({
    kind: t.literal("url"),
    target: t.string({ min: 8, max: 2048 }),
    ttlHours: t.optional(t.int({ min: 1, max: 8760 })),
  }),
  t.object({
    kind: t.literal("alias"),
    of: t.string({ min: 7, max: 7 }),
  }),
]);

const Link = t.object({
  code: t.string(),
  target: t.string(),
  kind: t.enum(["url", "alias"]),
  hits: t.int(),
  createdAt: t.int(),
});

type Link = Infer<typeof Link>;

const present = (row: Row): Link => ({
  code: row.code,
  target: row.target,
  kind: row.kind as Link["kind"],
  hits: row.hits,
  createdAt: row.created_at,
});

const app = orvox({
  maxRequestBodySize: 8192,
  openapi: { title: "Links", version: "1.0.0" },
});

app.use(header("x-powered-by", "orvox"));

// --- public ------------------------------------------------------------

app.get("/health", {
  response: t.object({ ok: t.boolean(), links: t.int() }),
  handler: () => ({ ok: true, links: statements.count.get()?.n ?? 0 }),
});

// The redirect is deliberately raw: a 302 with a Location header is not
// something a body schema describes, and this route wants no middleware.
app.raw("GET", "/r/:code", request => {
  const code = request.params.code;
  const row = statements.byCode.get(code);
  if (!row || !live(row)) return new Response("Not Found", { status: 404 });
  statements.hit.run(code);
  const target = row.kind === "alias"
    ? statements.byCode.get(row.target)?.target
    : row.target;
  if (!target) return new Response("Not Found", { status: 404 });
  return new Response(null, { status: 302, headers: { location: target } });
});

// --- authenticated -----------------------------------------------------

const apiKey = guard(({ headers }) =>
  headers.authorization === `Bearer ${process.env.LINKS_KEY ?? "dev-key"}`
    ? undefined
    : new Response("Unauthorized", { status: 401 }));

const caller = derive(({ headers }) => ({ caller: headers["x-caller"] ?? "anonymous" }));

app.group("/api", { use: [apiKey, header("cache-control", "no-store")] }, api => {
  api.get("/links", {
    query: t.object({
      after: t.optional(t.string({ min: 1, max: 7 })),
      limit: t.optional(t.int({ min: 1, max: 100 })),
      kind: t.optional(t.enum(["url", "alias"])),
    }),
    handler: ({ query }) => {
      const rows = statements.page.all(query.after ?? "", query.limit ?? 20);
      const filtered = query.kind ? rows.filter(row => row.kind === query.kind) : rows;
      return {
        links: filtered.filter(live).map(present),
        next: rows.length ? rows[rows.length - 1]!.code : null,
      };
    },
  });

  api.post("/links", {
    body: NewLink,
    handler: ({ body }) => {
      if (body.kind === "alias" && !statements.byCode.get(body.of)) {
        return Response.json(
          { error: "UNKNOWN_ALIAS", message: `No link with code ${body.of}.` },
          { status: 422 },
        );
      }
      const code = newCode();
      const expiresAt = body.kind === "url" && body.ttlHours
        ? Date.now() + body.ttlHours * 3_600_000
        : null;
      const target = body.kind === "url" ? body.target : body.of;
      statements.insert.run(code, target, body.kind, expiresAt, Date.now());
      return Response.json(present(statements.byCode.get(code)!), { status: 201 });
    },
  });

  api.group("/links/:code", { use: [caller] }, one => {
    one.get("/stats", {
      params: t.object({ code: t.string({ min: 7, max: 7 }) }),
      response: t.object({ code: t.string(), hits: t.int(), readBy: t.string() }),
      handler: ({ params, caller: by }) => {
        const row = statements.byCode.get(params.code);
        if (!row) return new Response("Not Found", { status: 404 });
        return { code: row.code, hits: row.hits, readBy: by };
      },
    });

    one.delete("", {
      params: t.object({ code: t.string({ min: 7, max: 7 }) }),
      handler: ({ params }) => {
        if (!statements.byCode.get(params.code)) {
          return new Response("Not Found", { status: 404 });
        }
        statements.remove.run(params.code);
        return new Response(null, { status: 204 });
      },
    });
  });
});

app.onError(error => Response.json({ error: "INTERNAL", message: error.message }, { status: 500 }));
app.onStop(() => db.close());

export default app;
