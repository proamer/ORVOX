import { orvox } from "@orvox/core";

const app = orvox();

app.post("/typed/:id", ({ body, query, headers, cookies, request, server, params }) => {
  const id: string = params.id;
  const unknownBody: unknown = body;
  const queryValue: string | undefined = query.limit;
  const headerValue: string | null = headers.authorization;
  const cookieValue: string | null = cookies.get("session");
  const method: string = request.method;
  const port: number | undefined = server.port;

  return { id, unknownBody, queryValue, headerValue, cookieValue, method, port };
});
