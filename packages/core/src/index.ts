import type { BunRequest, CookieMap, Server, ServerWebSocket } from "bun";
import type { AnySchema, Infer } from "@orvox/schema";

export { t } from "@orvox/schema";
export type { AnySchema, Infer, Schema } from "@orvox/schema";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

type ParamName<Segment extends string> = Segment extends `:${infer Name}`
  ? Name
  : never;

type ParamNames<Path extends string> =
  Path extends `${infer Segment}/${infer Rest}`
    ? ParamName<Segment> | ParamNames<Rest>
    : ParamName<Path>;

export type RouteParams<Path extends string> = string extends Path
  ? Record<string, string>
  : { readonly [Name in ParamNames<Path>]: string };

export type RouteContext<
  Path extends string,
  Body = unknown,
  Extension extends object = Record<never, never>,
> = {
  readonly params: RouteParams<Path>;
  readonly body: Body;
  readonly query: Readonly<Record<string, string | undefined>>;
  readonly headers: Readonly<Record<string, string | null>>;
  readonly cookies: CookieMap;
  readonly request: BunRequest<Path>;
  readonly server: Server<unknown>;
} & Extension;

export type RouteHandler<
  Path extends string,
  Result = unknown,
  Body = unknown,
  Extension extends object = Record<never, never>,
> = (
  context: RouteContext<Path, Body, Extension>,
) => Result | Promise<Result>;

export type RawHandler<Path extends string> = (
  request: BunRequest<Path>,
  server: Server<unknown>,
) => Response | Promise<Response>;

export type OrvoxOptions = Readonly<{
  maxRequestBodySize?: number;
}>;

export type WebSocketRoute = Readonly<{
  open?: (socket: ServerWebSocket<unknown>) => void | Promise<void>;
  message: (
    socket: ServerWebSocket<unknown>,
    message: string | Buffer<ArrayBuffer>,
  ) => void | Promise<void>;
  close?: (
    socket: ServerWebSocket<unknown>,
    code: number,
    reason: string,
  ) => void | Promise<void>;
}>;

export type BodyRouteOptions<
  Path extends string,
  BodySchema extends AnySchema,
  Result,
  Extension extends object = Record<never, never>,
> = Readonly<{
  body: BodySchema;
  handler: RouteHandler<Path, Result, Infer<BodySchema>, Extension>;
}>;

export type MiddlewareContext = RouteContext<string> & Record<string, any>;

export type HeaderMiddleware = Readonly<{
  kind: "header";
  name: string;
  value: string;
}>;

export type GuardMiddleware = Readonly<{
  kind: "guard";
  handler: (context: MiddlewareContext) => Response | void | Promise<Response | void>;
}>;

export type DeriveMiddleware<Extension extends object> = Readonly<{
  kind: "derive";
  handler: (context: MiddlewareContext) => Extension | Promise<Extension>;
}>;

export type Middleware = HeaderMiddleware | GuardMiddleware | DeriveMiddleware<object>;
export type MiddlewareInput = Middleware | readonly Middleware[];

type OneMiddlewareExtension<Value> =
  Value extends DeriveMiddleware<infer Extension> ? Extension : Record<never, never>;
type UnionToIntersection<Value> =
  (Value extends unknown ? (input: Value) => void : never) extends
    (input: infer Intersection) => void ? Intersection : never;
export type MiddlewareExtension<Value> = Value extends readonly unknown[]
  ? UnionToIntersection<OneMiddlewareExtension<Value[number]>>
  : OneMiddlewareExtension<Value>;

type JoinPath<Prefix extends string, Path extends string> = Prefix extends ""
  ? Path
  : `${Prefix}${Path}`;

type MiddlewareRouteOptions<
  Path extends string,
  Result,
  Body,
  Extension extends object,
  Use extends MiddlewareInput,
> = Readonly<{
  use: Use;
  handler: RouteHandler<Path, Result, Body, Extension & MiddlewareExtension<Use>>;
}>;

type MiddlewareBodyRouteOptions<
  Path extends string,
  Result,
  BodySchema extends AnySchema,
  Extension extends object,
  Use extends MiddlewareInput,
> = MiddlewareRouteOptions<Path, Result, Infer<BodySchema>, Extension, Use> &
  Readonly<{ body: BodySchema }>;

export interface OrvoxApp<
  Extension extends object = Record<never, never>,
  Prefix extends string = "",
> {
  get<const Path extends string, Result>(
    path: Path,
    handler: RouteHandler<JoinPath<Prefix, Path>, Result, unknown, Extension>,
  ): this;
  get<const Path extends string, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareRouteOptions<JoinPath<Prefix, Path>, Result, unknown, Extension, Use>,
  ): this;
  post<const Path extends string, Result>(
    path: Path,
    handler: RouteHandler<JoinPath<Prefix, Path>, Result, unknown, Extension>,
  ): this;
  post<const Path extends string, BodySchema extends AnySchema, Result>(
    path: Path,
    options: BodyRouteOptions<JoinPath<Prefix, Path>, BodySchema, Result, Extension>,
  ): this;
  post<const Path extends string, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareRouteOptions<JoinPath<Prefix, Path>, Result, unknown, Extension, Use>,
  ): this;
  post<
    const Path extends string,
    BodySchema extends AnySchema,
    const Use extends MiddlewareInput,
    Result,
  >(
    path: Path,
    options: MiddlewareBodyRouteOptions<JoinPath<Prefix, Path>, Result, BodySchema, Extension, Use>,
  ): this;
  put<const Path extends string, Result>(
    path: Path,
    handler: RouteHandler<JoinPath<Prefix, Path>, Result, unknown, Extension>,
  ): this;
  put<const Path extends string, BodySchema extends AnySchema, Result>(
    path: Path,
    options: BodyRouteOptions<JoinPath<Prefix, Path>, BodySchema, Result, Extension>,
  ): this;
  put<const Path extends string, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareRouteOptions<JoinPath<Prefix, Path>, Result, unknown, Extension, Use>,
  ): this;
  put<const Path extends string, BodySchema extends AnySchema, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareBodyRouteOptions<JoinPath<Prefix, Path>, Result, BodySchema, Extension, Use>,
  ): this;
  patch<const Path extends string, Result>(
    path: Path,
    handler: RouteHandler<JoinPath<Prefix, Path>, Result, unknown, Extension>,
  ): this;
  patch<const Path extends string, BodySchema extends AnySchema, Result>(
    path: Path,
    options: BodyRouteOptions<JoinPath<Prefix, Path>, BodySchema, Result, Extension>,
  ): this;
  patch<const Path extends string, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareRouteOptions<JoinPath<Prefix, Path>, Result, unknown, Extension, Use>,
  ): this;
  patch<const Path extends string, BodySchema extends AnySchema, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareBodyRouteOptions<JoinPath<Prefix, Path>, Result, BodySchema, Extension, Use>,
  ): this;
  delete<const Path extends string, Result>(
    path: Path,
    handler: RouteHandler<JoinPath<Prefix, Path>, Result, unknown, Extension>,
  ): this;
  delete<const Path extends string, BodySchema extends AnySchema, Result>(
    path: Path,
    options: BodyRouteOptions<JoinPath<Prefix, Path>, BodySchema, Result, Extension>,
  ): this;
  delete<const Path extends string, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareRouteOptions<JoinPath<Prefix, Path>, Result, unknown, Extension, Use>,
  ): this;
  delete<const Path extends string, BodySchema extends AnySchema, const Use extends MiddlewareInput, Result>(
    path: Path,
    options: MiddlewareBodyRouteOptions<JoinPath<Prefix, Path>, Result, BodySchema, Extension, Use>,
  ): this;
  raw<const Path extends string>(
    method: HttpMethod,
    path: Path,
    handler: RawHandler<JoinPath<Prefix, Path>>,
  ): this;
  use<Value extends Middleware>(middleware: Value): OrvoxApp<Extension & MiddlewareExtension<Value>, Prefix>;
  group<const GroupPrefix extends string, const Use extends MiddlewareInput>(
    prefix: GroupPrefix,
    options: Readonly<{ use: Use }>,
    configure: (group: OrvoxApp<Extension & MiddlewareExtension<Use>, JoinPath<Prefix, GroupPrefix>>) => void,
  ): this;
  onRequest(handler: (request: BunRequest<string>) => void | Promise<void>): this;
  onError(handler: (error: Error) => unknown | Promise<unknown>): this;
  onStop(handler: (server: Server<unknown>) => void | Promise<void>): this;
  ws<const Path extends string>(path: Path, handlers: WebSocketRoute): this;
}

export function header(name: string, value: string): HeaderMiddleware {
  const headers = new Headers([[name, value]]);
  const normalizedName = [...headers.keys()][0]!;
  return Object.freeze({ kind: "header", name: normalizedName, value: headers.get(normalizedName)! });
}

export function guard(
  handler: GuardMiddleware["handler"],
): GuardMiddleware {
  return Object.freeze({ kind: "guard", handler });
}

export function derive<Extension extends object>(
  handler: (context: MiddlewareContext) => Extension | Promise<Extension>,
): DeriveMiddleware<Extension> {
  return Object.freeze({ kind: "derive", handler });
}

export function orvox(_options: OrvoxOptions = {}): OrvoxApp {
  const app = {
    get() {
      return app;
    },
    post() {
      return app;
    },
    put() {
      return app;
    },
    patch() {
      return app;
    },
    delete() {
      return app;
    },
    raw() {
      return app;
    },
    use() {
      return app;
    },
    group(_prefix: string, _options: unknown, configure: (group: OrvoxApp) => void) {
      configure(app as OrvoxApp);
      return app;
    },
    onRequest() {
      return app;
    },
    onError() {
      return app;
    },
    onStop() {
      return app;
    },
    ws() {
      return app;
    },
  } as OrvoxApp;
  return app;
}
