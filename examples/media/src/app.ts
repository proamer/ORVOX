import { orvox, t } from "@orvox/core";

const app = orvox({ maxRequestBodySize: 1_048_576 });

const clips = new Map<string, ArrayBuffer>();

// A declared body schema forces application/json. Uploads are bytes, so this
// route takes the request itself rather than a parsed body.
app.post("/clips", async ({ request }) => {
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength) return new Response("Empty", { status: 400 });
  const id = crypto.randomUUID().slice(0, 8);
  clips.set(id, bytes);
  return Response.json({ id, bytes: bytes.byteLength }, { status: 201 });
});

app.get("/clips/:id", ({ params }) => {
  const clip = clips.get(params.id);
  return clip
    ? new Response(clip, { headers: { "content-type": "application/octet-stream" } })
    : new Response("Not Found", { status: 404 });
});

// A streamed body: the handler returns before the last chunk exists.
app.get("/countdown", {
  query: t.object({ from: t.optional(t.int({ min: 1, max: 20 })) }),
  handler: ({ query }) => {
    let n = query.from ?? 3;
    return new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode(`${n}\n`));
          if (--n < 1) controller.close();
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  },
});

// Server-sent events, which are just a stream that never says it is done.
app.get("/events", () =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const tick of [1, 2, 3]) {
          controller.enqueue(new TextEncoder().encode(`data: tick ${tick}\n\n`));
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  ));

app.ws("/echo", {
  open: socket => socket.send("ready"),
  message: (socket, message) => socket.send(`echo:${message}`),
});

export default app;
