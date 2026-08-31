import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import ts from "typescript";
import {
  emitStringMapValidation,
  emitValidation,
  parseSchemaExpression,
  schemaToOpenAPI,
  schemaNamespaces,
  topLevelInitializers,
  type SchemaIR,
} from "./schema.ts";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseMode =
  | "static"
  | "text"
  | "json"
  | "response"
  | "dynamic";

export type RouteNeeds = {
  body: boolean;
  query: boolean;
  headers: string[] | false;
  cookies: boolean;
  server: boolean;
  rawRequest: boolean;
};

export type MiddlewareManifestEntry =
  | { kind: "header"; name: string; value: string }
  | { kind: "guard" }
  | { kind: "derive"; keys: string[] };

export type RouteManifestEntry = {
  method: HttpMethod;
  path: string;
  params: string[];
  needs: RouteNeeds;
  middleware: MiddlewareManifestEntry[];
  responseMode: ResponseMode;
  schema?: SchemaIR;
  querySchema?: SchemaIR;
  paramsSchema?: SchemaIR;
};

export type RoutesManifest = {
  version: 1;
  entry: string;
  routes: RouteManifestEntry[];
};

export type AnalysisWarning = {
  code: string;
  route: string;
  message: string;
};

export type AnalysisReport = {
  version: 1;
  entry: string;
  warnings: AnalysisWarning[];
};

export type CompileSourceOptions = {
  entryPath: string;
  outputPath?: string;
};

export type CompileResult = {
  code: string;
  manifest: RoutesManifest;
  analysis: AnalysisReport;
  openapi: OpenAPIDocument;
};

export type OpenAPIDocument = {
  openapi: "3.1.0";
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
};

export type CompileFilesResult = CompileResult & {
  serverPath: string;
  manifestPath: string;
  analysisPath: string;
  openapiPath: string;
};

export class CompileError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CompileError";
  }
}

type HandlerNode = ts.ArrowFunction | ts.FunctionExpression;

type CompiledMiddleware =
  | { kind: "header"; name: string; value: string }
  | { kind: "guard"; handler: HandlerNode }
  | { kind: "derive"; handler: HandlerNode; keys: string[] };

type CompiledRoute = RouteManifestEntry & {
  handler: HandlerNode;
  raw: boolean;
  middlewareNodes: CompiledMiddleware[];
};

type RuntimeHooks = {
  maxRequestBodySize: number;
  openapi: { title: string; version: string };
  onRequest?: HandlerNode;
  onError?: HandlerNode;
  onStop?: HandlerNode;
};

type CompiledWebSocketRoute = {
  path: string;
  open?: HandlerNode;
  message: HandlerNode;
  close?: HandlerNode;
};

const routeMethods = new Map<string, HttpMethod>([
  ["get", "GET"],
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
]);

const emptyNeeds = (): RouteNeeds => ({
  body: false,
  query: false,
  headers: false,
  cookies: false,
  server: false,
  rawRequest: false,
});

const slash = (value: string) => value.replaceAll("\\", "/");

const unwrap = (expression: ts.Expression): ts.Expression => {
  while (ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  return expression;
};

const isHandler = (node: ts.Node | undefined): node is HandlerNode =>
  !!node && (ts.isArrowFunction(node) || ts.isFunctionExpression(node));

const isStaticValue = (input: ts.Expression): boolean => {
  const expression = unwrap(input);
  if (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isPrefixUnaryExpression(expression)) {
    return (
      [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(
        expression.operator,
      ) && ts.isNumericLiteral(expression.operand)
    );
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.every(
      element => ts.isExpression(element) && isStaticValue(element),
    );
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.every(
      property =>
        ts.isPropertyAssignment(property) &&
        !ts.isComputedPropertyName(property.name) &&
        isStaticValue(property.initializer),
    );
  }
  return false;
};

const isTextExpression = (input: ts.Expression) => {
  const expression = unwrap(input);
  return (
    ts.isStringLiteralLike(expression) ||
    ts.isTemplateExpression(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  );
};

const isJsonExpression = (input: ts.Expression) => {
  const expression = unwrap(input);
  return (
    ts.isObjectLiteralExpression(expression) ||
    ts.isArrayLiteralExpression(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword ||
    expression.kind === ts.SyntaxKind.NullKeyword
  );
};

const isResponseExpression = (input: ts.Expression) => {
  const expression = unwrap(input);
  if (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "Response"
  ) {
    return true;
  }
  return (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    ts.isIdentifier(expression.expression.expression) &&
    expression.expression.expression.text === "Response"
  );
};

const inferResponseMode = (handler: HandlerNode): ResponseMode => {
  if (ts.isBlock(handler.body)) return "dynamic";
  const expression = unwrap(handler.body);
  if (handler.parameters.length === 0 && isStaticValue(expression)) {
    return "static";
  }
  if (isResponseExpression(expression)) return "response";
  if (isTextExpression(expression)) return "text";
  if (isJsonExpression(expression)) return "json";
  return "dynamic";
};

const pathParams = (path: string) => {
  const params: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment.startsWith(":")) continue;
    const name = segment.slice(1);
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) {
      throw new CompileError(
        "ORVOX_INVALID_PATH_PARAM",
        `Invalid route parameter "${name}" in "${path}".`,
      );
    }
    if (params.includes(name)) {
      throw new CompileError(
        "ORVOX_DUPLICATE_PATH_PARAM",
        `Duplicate route parameter "${name}" in "${path}".`,
      );
    }
    params.push(name);
  }
  return params;
};

const validatePath = (path: string) => {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new CompileError(
      "ORVOX_INVALID_PATH",
      `Route path must start with "/" and exclude query/hash: "${path}".`,
    );
  }
  pathParams(path);
};

const routePattern = (path: string) =>
  path
    .split("/")
    .map(segment => (segment.startsWith(":") ? ":" : segment))
    .join("/");

const appRouteCall = (node: ts.Node, appName: string) => {
  if (!ts.isCallExpression(node)) return undefined;
  const callee = node.expression;
  if (
    !ts.isPropertyAccessExpression(callee) ||
    !ts.isIdentifier(callee.expression) ||
    callee.expression.text !== appName
  ) {
    return undefined;
  }
  return routeMethods.has(callee.name.text) || callee.name.text === "raw"
    ? node
    : undefined;
};

const literalText = (node: ts.Node | undefined, code: string, message: string) => {
  if (!node || !ts.isStringLiteralLike(node)) {
    throw new CompileError(code, message);
  }
  return node.text;
};

const literalNumber = (node: ts.Expression | undefined) => {
  if (!node) return undefined;
  node = unwrap(node);
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (
    ts.isPrefixUnaryExpression(node) &&
    ts.isNumericLiteral(node.operand) &&
    [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(node.operator)
  ) {
    const value = Number(node.operand.text);
    return node.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  return undefined;
};

const accessName = (node: ts.Node) => {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    node.argumentExpression &&
    ts.isStringLiteralLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return undefined;
};

const collectHeaderNames = (
  handler: HandlerNode,
  localNames: Set<string>,
  contextName?: string,
) => {
  const names: string[] = [];
  const add = (name: string) => {
    name = name.toLowerCase();
    if (!names.includes(name)) names.push(name);
  };
  const isBase = (node: ts.Node) => {
    if (ts.isIdentifier(node) && localNames.has(node.text)) return true;
    if (!contextName) return false;
    return (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === contextName &&
      accessName(node) === "headers"
    );
  };
  const visit = (node: ts.Node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      isBase(node.expression)
    ) {
      add(accessName(node) ?? "*");
    } else if (isBase(node)) {
      const parent = node.parent;
      const consumedByAccess =
        (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
        parent.expression === node;
      if (!consumedByAccess) add("*");
    }
    ts.forEachChild(node, visit);
  };
  visit(handler.body);
  return names;
};

const contextNeeds = (
  handler: HandlerNode,
  raw: boolean,
  route: string,
  warnings: AnalysisWarning[],
  extensions: ReadonlySet<string> = new Set(),
) => {
  const needs = emptyNeeds();
  if (raw) {
    needs.rawRequest = true;
    needs.server = handler.parameters.length > 1;
    return needs;
  }
  const parameter = handler.parameters[0];
  if (!parameter) return needs;
  const mark = (key: string) => {
    if (key === "params") return;
    if (key === "body") needs.body = true;
    else if (key === "query") needs.query = true;
    else if (key === "cookies") needs.cookies = true;
    else if (key === "request" || key === "rawRequest") needs.rawRequest = true;
    else if (key === "server") needs.server = true;
    else if (key !== "headers" && !extensions.has(key)) {
      throw new CompileError(
        "ORVOX_UNSUPPORTED_CONTEXT",
        `Context property "${key}" is not declared by this route.`,
      );
    }
  };
  if (ts.isIdentifier(parameter.name)) {
    const contextName = parameter.name.text;
    let conservative = false;
    const visit = (node: ts.Node) => {
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === contextName
      ) {
        const key = accessName(node);
        if (key) mark(key);
        else conservative = true;
      } else if (ts.isIdentifier(node) && node.text === contextName) {
        const parent = node.parent;
        const directAccess =
          (ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) &&
          parent.expression === node;
        if (!directAccess) conservative = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(handler.body);
    const headerNames = collectHeaderNames(handler, new Set(), contextName);
    if (headerNames.length) needs.headers = headerNames;
    if (conservative) {
      needs.body = true;
      needs.query = true;
      needs.headers = ["*"];
      needs.cookies = true;
      needs.rawRequest = true;
      needs.server = true;
      warnings.push({
        code: "ORVOX_CONSERVATIVE_CONTEXT",
        route,
        message: "Dynamic context access materializes all request data.",
      });
    }
    return needs;
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    throw new CompileError(
      "ORVOX_UNSUPPORTED_CONTEXT",
      "Handler context must be an object binding pattern or identifier.",
    );
  }
  const headerLocals = new Set<string>();
  for (const element of parameter.name.elements) {
    if (element.dotDotDotToken || !ts.isIdentifier(element.name)) {
      throw new CompileError(
        "ORVOX_UNSUPPORTED_CONTEXT",
        "Nested and rest context bindings are not supported in v0.1.",
      );
    }
    const key = element.propertyName ?? element.name;
    const keyText =
      ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : "";
    mark(keyText);
    if (keyText === "headers") headerLocals.add(element.name.text);
  }
  const headerNames = collectHeaderNames(handler, headerLocals);
  if (headerLocals.size) needs.headers = headerNames.length ? headerNames : ["*"];
  return needs;
};

const mergeNeeds = (target: RouteNeeds, source: RouteNeeds) => {
  target.body ||= source.body;
  target.query ||= source.query;
  target.cookies ||= source.cookies;
  target.server ||= source.server;
  target.rawRequest ||= source.rawRequest;
  if (source.headers) {
    if (!target.headers) target.headers = [];
    if (source.headers.includes("*") || target.headers.includes("*")) {
      target.headers = ["*"];
    } else {
      for (const name of source.headers) {
        if (!target.headers.includes(name)) target.headers.push(name);
      }
    }
  }
};

const findAppName = (sourceFile: ts.SourceFile) => {
  const orvoxBindings = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@orvox/core"
    ) {
      continue;
    }
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "orvox") {
        orvoxBindings.add(element.name.text);
      }
    }
  }

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.initializer &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        orvoxBindings.has(declaration.initializer.expression.text)
      ) {
        return declaration.name.text;
      }
    }
  }
  throw new CompileError(
    "ORVOX_APP_REQUIRED",
    'Expected a top-level "const app = orvox()" declaration.',
  );
};

const middlewareBuilders = (sourceFile: ts.SourceFile) => {
  const builders = new Map<string, "header" | "guard" | "derive">();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@orvox/core"
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      const imported = (element.propertyName ?? element.name).text;
      if (imported === "header" || imported === "guard" || imported === "derive") {
        builders.set(element.name.text, imported);
      }
    }
  }
  return builders;
};

const deriveKeys = (handler: HandlerNode) => {
  let output: ts.Expression | undefined;
  if (!ts.isBlock(handler.body)) output = unwrap(handler.body);
  else {
    const returns = handler.body.statements.filter(ts.isReturnStatement);
    if (returns.length === 1 && returns[0]!.expression) output = unwrap(returns[0]!.expression);
  }
  if (!output || !ts.isObjectLiteralExpression(output)) {
    throw new CompileError(
      "ORVOX_STATIC_DERIVE_REQUIRED",
      "derive() handlers must return an object literal directly.",
    );
  }
  const keys: string[] = [];
  for (const property of output.properties) {
    let name: string | undefined;
    if (
      (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name))
    ) name = property.name.text;
    if (!name) {
      throw new CompileError(
        "ORVOX_STATIC_DERIVE_REQUIRED",
        "derive() results must use static properties without spreads.",
      );
    }
    if (keys.includes(name)) {
      throw new CompileError("ORVOX_DERIVE_KEY", `Duplicate derived context key "${name}".`);
    }
    keys.push(name);
  }
  return keys;
};

const parseMiddleware = (
  input: ts.Expression,
  builders: ReadonlyMap<string, "header" | "guard" | "derive">,
  declarations: ReadonlyMap<string, ts.Expression>,
  usedDeclarations: Set<string>,
  resolving = new Set<string>(),
): CompiledMiddleware => {
  input = unwrap(input);
  if (ts.isIdentifier(input)) {
    const initializer = declarations.get(input.text);
    if (!initializer) {
      throw new CompileError(
        "ORVOX_STATIC_MIDDLEWARE_REQUIRED",
        `Middleware "${input.text}" must be a top-level const.`,
      );
    }
    if (resolving.has(input.text)) {
      throw new CompileError("ORVOX_MIDDLEWARE_CYCLE", `Middleware "${input.text}" references itself.`);
    }
    usedDeclarations.add(input.text);
    resolving.add(input.text);
    const middleware = parseMiddleware(initializer, builders, declarations, usedDeclarations, resolving);
    resolving.delete(input.text);
    return middleware;
  }
  if (!ts.isCallExpression(input) || !ts.isIdentifier(input.expression)) {
    throw new CompileError(
      "ORVOX_STATIC_MIDDLEWARE_REQUIRED",
      "Middleware must use an imported header(), guard(), or derive() builder.",
    );
  }
  const kind = builders.get(input.expression.text);
  if (!kind) {
    throw new CompileError(
      "ORVOX_STATIC_MIDDLEWARE_REQUIRED",
      "Middleware must use an imported header(), guard(), or derive() builder.",
    );
  }
  if (kind === "header") {
    const name = literalText(
      input.arguments[0],
      "ORVOX_LITERAL_HEADER_REQUIRED",
      "Middleware header names must be string literals.",
    ).toLowerCase();
    const value = literalText(
      input.arguments[1],
      "ORVOX_LITERAL_HEADER_REQUIRED",
      "Middleware header values must be string literals.",
    );
    try {
      new Headers([[name, value]]);
    } catch {
      throw new CompileError("ORVOX_INVALID_HEADER", `Invalid response header "${name}".`);
    }
    return { kind, name, value };
  }
  const handler = input.arguments[0];
  if (!isHandler(handler)) {
    throw new CompileError(
      "ORVOX_INLINE_MIDDLEWARE_REQUIRED",
      `${kind}() handlers must be inline arrow or function expressions.`,
    );
  }
  return kind === "guard"
    ? { kind, handler }
    : { kind, handler, keys: deriveKeys(handler) };
};

const parseMiddlewareInput = (
  input: ts.Expression | undefined,
  builders: ReadonlyMap<string, "header" | "guard" | "derive">,
  declarations: ReadonlyMap<string, ts.Expression>,
  usedDeclarations: Set<string>,
) => {
  if (!input) return [];
  input = unwrap(input);
  const expressions = ts.isArrayLiteralExpression(input)
    ? input.elements.map(element => {
        if (!ts.isExpression(element) || ts.isSpreadElement(element)) {
          throw new CompileError(
            "ORVOX_STATIC_MIDDLEWARE_REQUIRED",
            "Middleware arrays cannot contain spreads.",
          );
        }
        return element;
      })
    : [input];
  return expressions.map(expression =>
    parseMiddleware(expression, builders, declarations, usedDeclarations),
  );
};

const middlewareManifest = (middleware: CompiledMiddleware[]): MiddlewareManifestEntry[] =>
  middleware.map(item => item.kind === "header"
    ? { kind: item.kind, name: item.name, value: item.value }
    : item.kind === "derive"
      ? { kind: item.kind, keys: item.keys }
      : { kind: item.kind });

const joinRoutePath = (prefix: string, path: string) => {
  if (!prefix || prefix === "/") return path;
  return path === "/" ? prefix : `${prefix}${path}`;
};

const parseRoutes = (
  sourceFile: ts.SourceFile,
  appName: string,
  warnings: AnalysisWarning[],
) => {
  const namespaces = schemaNamespaces(sourceFile);
  const declarations = topLevelInitializers(sourceFile);
  const usedSchemas = new Set<string>();
  const builders = middlewareBuilders(sourceFile);
  const usedMiddleware = new Set<string>();
  const directAppCalls = new Set<ts.CallExpression>();
  const seen = new Set<string>();
  const patterns = new Map<string, string>();
  const routes: CompiledRoute[] = [];

  const addRoute = (
    call: ts.CallExpression,
    prefix: string,
    inheritedMiddleware: CompiledMiddleware[],
  ) => {
    const callee = call.expression as ts.PropertyAccessExpression;
    const raw = callee.name.text === "raw";
    const method = raw
      ? literalText(
          call.arguments[0],
          "ORVOX_LITERAL_METHOD_REQUIRED",
          "Raw route methods must be string literals.",
        ).toUpperCase()
      : routeMethods.get(callee.name.text)!;
    if (!(["GET", "POST", "PUT", "PATCH", "DELETE"] as string[]).includes(method)) {
      throw new CompileError(
        "ORVOX_UNSUPPORTED_METHOD",
        `Unsupported HTTP method "${method}".`,
      );
    }
    const localPath = literalText(
      call.arguments[raw ? 1 : 0],
      "ORVOX_LITERAL_PATH_REQUIRED",
      "Route paths must be string literals.",
    );
    const path = joinRoutePath(prefix, localPath);
    validatePath(path);
    const routeInput = call.arguments[raw ? 2 : 1];
    let handler: ts.Expression | undefined = routeInput;
    let schema: SchemaIR | undefined;
    let querySchema: SchemaIR | undefined;
    let paramsSchema: SchemaIR | undefined;
    let routeMiddleware: CompiledMiddleware[] = [];
    if (!raw && routeInput && ts.isObjectLiteralExpression(unwrap(routeInput))) {
      const options = unwrap(routeInput) as ts.ObjectLiteralExpression;
      const properties = new Map<string, ts.Expression>();
      for (const property of options.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
        ) {
          throw new CompileError(
            "ORVOX_STATIC_ROUTE_OPTIONS_REQUIRED",
            "Route options must use static property assignments.",
          );
        }
        if (!["handler", "body", "query", "params", "use"].includes(property.name.text)) {
          throw new CompileError(
            "ORVOX_ROUTE_OPTION",
            `Unsupported route option "${property.name.text}".`,
          );
        }
        properties.set(property.name.text, property.initializer);
      }
      handler = properties.get("handler");
      const bodySchema = properties.get("body");
      if (bodySchema) {
        schema = parseSchemaExpression(
          bodySchema,
          namespaces,
          declarations,
          usedSchemas,
          (code, message) => {
            throw new CompileError(code, message);
          },
        );
      }
      const queryOption = properties.get("query");
      if (queryOption) {
        querySchema = parseSchemaExpression(
          queryOption,
          namespaces,
          declarations,
          usedSchemas,
          (code, message) => {
            throw new CompileError(code, message);
          },
        );
        if (querySchema.kind !== "object") {
          throw new CompileError("ORVOX_ROUTE_OPTION", "A query schema must be t.object().");
        }
        for (const property of querySchema.properties) {
          if (!["string", "integer", "boolean"].includes(property.schema.kind)) {
            throw new CompileError(
              "ORVOX_ROUTE_OPTION",
              `Query parameter "${property.name}" must be a string, integer, or boolean.`,
            );
          }
        }
      }
      const paramsOption = properties.get("params");
      if (paramsOption) {
        paramsSchema = parseSchemaExpression(
          paramsOption,
          namespaces,
          declarations,
          usedSchemas,
          (code, message) => {
            throw new CompileError(code, message);
          },
        );
        if (paramsSchema.kind !== "object") {
          throw new CompileError("ORVOX_ROUTE_OPTION", "A params schema must be t.object().");
        }
        const declared = new Set(pathParams(path));
        for (const property of paramsSchema.properties) {
          if (!declared.has(property.name)) {
            throw new CompileError(
              "ORVOX_ROUTE_OPTION",
              `Path "${path}" declares no param "${property.name}".`,
            );
          }
          // A matched route always supplies every param in its path, so an
          // optional one describes a state the router cannot produce.
          if (!property.required) {
            throw new CompileError(
              "ORVOX_ROUTE_OPTION",
              `Path param "${property.name}" cannot be optional.`,
            );
          }
          if (!["string", "integer", "boolean"].includes(property.schema.kind)) {
            throw new CompileError(
              "ORVOX_ROUTE_OPTION",
              `Path param "${property.name}" must be a string, integer, or boolean.`,
            );
          }
        }
      }
      routeMiddleware = parseMiddlewareInput(
        properties.get("use"),
        builders,
        declarations,
        usedMiddleware,
      );
    }
    if (!isHandler(handler)) {
      throw new CompileError(
        "ORVOX_INLINE_HANDLER_REQUIRED",
        "Route handlers must be inline arrow or function expressions in v0.1.",
      );
    }
    const key = `${method} ${path}`;
    if (seen.has(key)) {
      throw new CompileError(
        "ORVOX_DUPLICATE_ROUTE",
        `Duplicate route: ${method} "${path}".`,
      );
    }
    seen.add(key);
    const patternKey = `${method} ${routePattern(path)}`;
    const existingPattern = patterns.get(patternKey);
    if (existingPattern) {
      throw new CompileError(
        "ORVOX_AMBIGUOUS_ROUTE",
        `Ambiguous route pattern: ${method} "${path}" conflicts with "${existingPattern}".`,
      );
    }
    patterns.set(patternKey, path);
    const middlewareNodes = raw ? [] : [...inheritedMiddleware, ...routeMiddleware];
    let responseMode = raw ? "response" : inferResponseMode(handler);
    if (
      responseMode === "static" &&
      middlewareNodes.some(item => item.kind !== "header") &&
      !ts.isBlock(handler.body)
    ) {
      responseMode = isTextExpression(handler.body) ? "text" : "json";
    }
    if (!raw && ts.isBlock(handler.body)) {
      warnings.push({
        code: "ORVOX_BLOCK_HANDLER_FALLBACK",
        route: key,
        message: "Block handler uses the conservative response adapter in v0.1.",
      });
    }
    const needs = emptyNeeds();
    const extensions = new Set<string>();
    for (const middleware of middlewareNodes) {
      if (middleware.kind === "header") continue;
      mergeNeeds(
        needs,
        contextNeeds(middleware.handler, false, key, warnings, extensions),
      );
      if (middleware.kind === "derive") {
        for (const name of middleware.keys) extensions.add(name);
      }
    }
    mergeNeeds(needs, contextNeeds(handler, raw, key, warnings, extensions));
    if (schema) needs.body = true;
    if (querySchema) needs.query = true;
    routes.push({
      method: method as HttpMethod,
      path,
      params: pathParams(path),
      needs,
      middleware: middlewareManifest(middlewareNodes),
      responseMode,
      handler,
      raw,
      middlewareNodes,
      ...(schema ? { schema } : {}),
      ...(querySchema ? { querySchema } : {}),
      ...(paramsSchema ? { paramsSchema } : {}),
    });
  };

  let globalMiddleware: CompiledMiddleware[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      !ts.isIdentifier(call.expression.expression) ||
      call.expression.expression.text !== appName
    ) continue;
    const name = call.expression.name.text;
    if (![...routeMethods.keys(), "raw", "use", "group"].includes(name)) continue;
    directAppCalls.add(call);
    if (name === "use") {
      if (routes.length) {
        warnings.push({
          code: "ORVOX_LATE_GLOBAL_MIDDLEWARE",
          route: `${routes[routes.length - 1]!.method} ${routes[routes.length - 1]!.path}`,
          message: "app.use() only applies to routes declared after it.",
        });
      }
      globalMiddleware = [
        ...globalMiddleware,
        ...parseMiddlewareInput(call.arguments[0], builders, declarations, usedMiddleware),
      ];
      continue;
    }
    if (name !== "group") {
      addRoute(call, "", globalMiddleware);
      continue;
    }

    const prefix = literalText(
      call.arguments[0],
      "ORVOX_LITERAL_GROUP_PREFIX_REQUIRED",
      "Group prefixes must be string literals.",
    );
    validatePath(prefix);
    if (prefix.length > 1 && prefix.endsWith("/")) {
      throw new CompileError("ORVOX_INVALID_GROUP_PREFIX", "Group prefixes cannot end with a slash.");
    }
    const options = call.arguments[1] && unwrap(call.arguments[1]);
    if (!options || !ts.isObjectLiteralExpression(options)) {
      throw new CompileError("ORVOX_STATIC_GROUP_REQUIRED", "Group options must be an object literal.");
    }
    let groupUse: ts.Expression | undefined;
    for (const property of options.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name)) ||
        property.name.text !== "use"
      ) {
        throw new CompileError("ORVOX_STATIC_GROUP_REQUIRED", "Group options only support a static use property.");
      }
      groupUse = property.initializer;
    }
    const configure = call.arguments[2];
    if (!isHandler(configure) || !ts.isBlock(configure.body)) {
      throw new CompileError("ORVOX_STATIC_GROUP_REQUIRED", "Group callbacks must be inline function blocks.");
    }
    const groupParameter = configure.parameters[0]?.name;
    if (!groupParameter || !ts.isIdentifier(groupParameter)) {
      throw new CompileError("ORVOX_STATIC_GROUP_REQUIRED", "Group callbacks require an identifier parameter.");
    }
    const groupMiddleware = [
      ...globalMiddleware,
      ...parseMiddlewareInput(groupUse, builders, declarations, usedMiddleware),
    ];
    const directGroupCalls = new Set<ts.CallExpression>();
    for (const groupStatement of configure.body.statements) {
      if (!ts.isExpressionStatement(groupStatement)) continue;
      const groupCall = appRouteCall(groupStatement.expression, groupParameter.text);
      if (!groupCall) continue;
      directGroupCalls.add(groupCall);
      addRoute(groupCall, prefix, groupMiddleware);
    }
    const inspectGroup = (node: ts.Node) => {
      const groupCall = appRouteCall(node, groupParameter.text);
      if (groupCall && !directGroupCalls.has(groupCall)) {
        throw new CompileError(
          "ORVOX_STATIC_ROUTE_REQUIRED",
          "Routes must be registered as top-level statements.",
        );
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === groupParameter.text &&
        ["use", "group"].includes(node.expression.name.text)
      ) {
        throw new CompileError(
          "ORVOX_STATIC_DSL_REQUIRED",
          "Nested groups and group-level use() are not supported in v0.1; declare middleware in the group options.",
        );
      }
      ts.forEachChild(node, inspectGroup);
    };
    inspectGroup(configure.body);
  }

  const inspectNested = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === appName &&
      [...routeMethods.keys(), "raw", "use", "group"].includes(node.expression.name.text) &&
      !directAppCalls.has(node)
    ) {
      if (routeMethods.has(node.expression.name.text) || node.expression.name.text === "raw") {
        throw new CompileError(
          "ORVOX_STATIC_ROUTE_REQUIRED",
          "Routes must be registered as top-level statements.",
        );
      }
      throw new CompileError(
        "ORVOX_STATIC_DSL_REQUIRED",
        "Middleware and groups must be registered as top-level statements.",
      );
    }
    ts.forEachChild(node, inspectNested);
  };
  inspectNested(sourceFile);

  const globalHeaders = new Map<string, string>();
  for (const middleware of globalMiddleware) {
    if (middleware.kind === "header") globalHeaders.set(middleware.name, middleware.value);
  }

  return {
    routes,
    globalHeaders,
    usedSchemas: new Set([...usedSchemas, ...usedMiddleware]),
  };
};

const parseRuntime = (sourceFile: ts.SourceFile, appName: string) => {
  // The spec describes the user's API, not this compiler, so the version has to
  // come from them. "0.0.0" is the honest placeholder until it does.
  const hooks: RuntimeHooks = {
    maxRequestBodySize: 1_048_576,
    openapi: { title: "ORVOX API", version: "0.0.0" },
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declaration.name) ||
        declaration.name.text !== appName ||
        !declaration.initializer ||
        !ts.isCallExpression(declaration.initializer)
      ) continue;
      const options = declaration.initializer.arguments[0] && unwrap(declaration.initializer.arguments[0]);
      if (!options) continue;
      if (!ts.isObjectLiteralExpression(options)) {
        throw new CompileError("ORVOX_STATIC_OPTIONS_REQUIRED", "orvox() options must be an object literal.");
      }
      for (const property of options.properties) {
        if (
          !ts.isPropertyAssignment(property) ||
          (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name)) ||
          !["maxRequestBodySize", "openapi"].includes(property.name.text)
        ) {
          throw new CompileError(
            "ORVOX_SERVER_OPTION",
            "Only maxRequestBodySize and openapi are supported in orvox() options.",
          );
        }
        if (property.name.text === "openapi") {
          const document = unwrap(property.initializer);
          if (!ts.isObjectLiteralExpression(document)) {
            throw new CompileError("ORVOX_SERVER_OPTION", "openapi must be an object literal.");
          }
          for (const field of document.properties) {
            // Read the name first so `{ version }` shorthand reports the value
            // problem it actually has instead of looking like an unknown key.
            const named = ts.isPropertyAssignment(field) || ts.isShorthandPropertyAssignment(field);
            const name = named && (ts.isIdentifier(field.name) || ts.isStringLiteralLike(field.name))
              ? field.name.text
              : undefined;
            if (!name || !["title", "version"].includes(name)) {
              throw new CompileError("ORVOX_SERVER_OPTION", "openapi accepts only title and version.");
            }
            const message = `openapi.${name} must be a non-empty string literal.`;
            if (!ts.isPropertyAssignment(field)) {
              throw new CompileError("ORVOX_SERVER_OPTION", message);
            }
            const text = literalText(unwrap(field.initializer), "ORVOX_SERVER_OPTION", message);
            if (!text) throw new CompileError("ORVOX_SERVER_OPTION", message);
            hooks.openapi[name as "title" | "version"] = text;
          }
          continue;
        }
        const value = literalNumber(property.initializer);
        if (value === undefined || !Number.isSafeInteger(value) || value <= 0) {
          throw new CompileError(
            "ORVOX_SERVER_OPTION",
            "maxRequestBodySize must be a positive integer literal.",
          );
        }
        hooks.maxRequestBodySize = value;
      }
    }
  }

  const directCalls = new Set<ts.CallExpression>();
  const websockets: CompiledWebSocketRoute[] = [];
  const websocketPaths = new Set<string>();
  const hookNames = new Set(["onRequest", "onError", "onStop"]);
  for (const statement of sourceFile.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      !ts.isIdentifier(call.expression.expression) ||
      call.expression.expression.text !== appName
    ) continue;
    const name = call.expression.name.text;
    if (!hookNames.has(name) && name !== "ws") continue;
    directCalls.add(call);
    if (hookNames.has(name)) {
      const handler = call.arguments[0];
      if (!isHandler(handler)) {
        throw new CompileError(
          "ORVOX_INLINE_HOOK_REQUIRED",
          `${name}() handlers must be inline arrow or function expressions.`,
        );
      }
      if (hooks[name as "onRequest" | "onError" | "onStop"]) {
        throw new CompileError("ORVOX_DUPLICATE_HOOK", `Duplicate ${name}() hook.`);
      }
      hooks[name as "onRequest" | "onError" | "onStop"] = handler;
      continue;
    }

    const path = literalText(
      call.arguments[0],
      "ORVOX_LITERAL_PATH_REQUIRED",
      "WebSocket paths must be string literals.",
    );
    validatePath(path);
    if (pathParams(path).length) {
      throw new CompileError(
        "ORVOX_STATIC_WEBSOCKET_PATH_REQUIRED",
        "WebSocket paths cannot contain parameters in v0.1.",
      );
    }
    if (websocketPaths.has(path)) {
      throw new CompileError("ORVOX_DUPLICATE_WEBSOCKET", `Duplicate WebSocket route: "${path}".`);
    }
    websocketPaths.add(path);
    const handlersInput = call.arguments[1] && unwrap(call.arguments[1]);
    if (!handlersInput || !ts.isObjectLiteralExpression(handlersInput)) {
      throw new CompileError("ORVOX_STATIC_WEBSOCKET_REQUIRED", "WebSocket handlers must be an object literal.");
    }
    const handlers = new Map<string, HandlerNode>();
    for (const property of handlersInput.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name)) ||
        !["open", "message", "close"].includes(property.name.text) ||
        !isHandler(property.initializer)
      ) {
        throw new CompileError(
          "ORVOX_STATIC_WEBSOCKET_REQUIRED",
          "WebSocket open, message, and close handlers must be inline functions.",
        );
      }
      if (handlers.has(property.name.text)) {
        throw new CompileError("ORVOX_WEBSOCKET_HANDLER", `Duplicate WebSocket ${property.name.text} handler.`);
      }
      handlers.set(property.name.text, property.initializer);
    }
    const message = handlers.get("message");
    if (!message) {
      throw new CompileError("ORVOX_WEBSOCKET_HANDLER", "WebSocket routes require a message handler.");
    }
    websockets.push({
      path,
      message,
      ...(handlers.get("open") ? { open: handlers.get("open")! } : {}),
      ...(handlers.get("close") ? { close: handlers.get("close")! } : {}),
    });
  }

  const inspectNested = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === appName &&
      (hookNames.has(node.expression.name.text) || node.expression.name.text === "ws") &&
      !directCalls.has(node)
    ) {
      throw new CompileError(
        "ORVOX_STATIC_DSL_REQUIRED",
        "Hooks and WebSocket routes must be registered as top-level statements.",
      );
    }
    ts.forEachChild(node, inspectNested);
  };
  inspectNested(sourceFile);
  return { hooks, websockets };
};

const isDefaultAppExport = (statement: ts.Statement, appName: string) =>
  ts.isExportAssignment(statement) &&
  !statement.isExportEquals &&
  ts.isIdentifier(statement.expression) &&
  statement.expression.text === appName;

const rewriteRelativeModule = (
  statement: ts.Statement,
  entryPath: string,
  outputPath: string,
) => {
  const rewrite = (specifier: ts.Expression | undefined) => {
    if (
      !specifier ||
      !ts.isStringLiteral(specifier) ||
      !specifier.text.startsWith(".")
    ) {
      return specifier;
    }
    const target = resolve(dirname(resolve(entryPath)), specifier.text);
    let next = slash(relative(dirname(resolve(outputPath)), target));
    if (!next.startsWith(".")) next = `./${next}`;
    return ts.factory.createStringLiteral(next);
  };
  if (ts.isImportDeclaration(statement)) {
    return ts.factory.updateImportDeclaration(
      statement,
      statement.modifiers,
      statement.importClause,
      rewrite(statement.moduleSpecifier)!,
      statement.attributes,
    );
  }
  if (ts.isExportDeclaration(statement)) {
    return ts.factory.updateExportDeclaration(
      statement,
      statement.modifiers,
      statement.isTypeOnly,
      statement.exportClause,
      rewrite(statement.moduleSpecifier),
      statement.attributes,
    );
  }
  return statement;
};

const referencedNames = (nodes: readonly ts.Node[]) => {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  for (const node of nodes) visit(node);
  return names;
};

const isCompilerImport = (statement: ts.Statement): statement is ts.ImportDeclaration =>
  ts.isImportDeclaration(statement) &&
  ts.isStringLiteral(statement.moduleSpecifier) &&
  ["@orvox/core", "@orvox/schema"].includes(statement.moduleSpecifier.text);

const isAppDslStatement = (statement: ts.Statement, appName: string) =>
  ts.isExpressionStatement(statement) &&
  ts.isCallExpression(statement.expression) &&
  ts.isPropertyAccessExpression(statement.expression.expression) &&
  ts.isIdentifier(statement.expression.expression.expression) &&
  statement.expression.expression.expression.text === appName &&
  [...routeMethods.keys(), "raw", "use", "group", "onRequest", "onError", "onStop", "ws"].includes(
    statement.expression.expression.name.text,
  );

const retainedSource = (
  sourceFile: ts.SourceFile,
  appName: string,
  entryPath: string,
  outputPath: string,
  usedSchemas: ReadonlySet<string>,
  printedNodes: readonly ts.Node[],
) => {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const print = (statement: ts.Statement) =>
    printer.printNode(
      ts.EmitHint.Unspecified,
      rewriteRelativeModule(statement, entryPath, outputPath),
      sourceFile,
    );
  const body = sourceFile.statements.filter(
    statement =>
      !isDefaultAppExport(statement, appName) && !isAppDslStatement(statement, appName),
  );

  // Compiled schema and middleware declarations disappear into the generated
  // checks, but only when nothing that survives compilation still names them.
  const compiled = new Map<string, ts.VariableDeclaration>();
  const roots: ts.Node[] = [...printedNodes];
  for (const statement of body) {
    if (isCompilerImport(statement)) continue;
    if (!ts.isVariableStatement(statement)) {
      roots.push(statement);
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      const name = ts.isIdentifier(declaration.name) ? declaration.name.text : "";
      if (name === appName) continue;
      if (usedSchemas.has(name)) compiled.set(name, declaration);
      else roots.push(declaration);
    }
  }
  const references = referencedNames(roots);
  const retained = new Set<string>();
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, declaration] of compiled) {
      if (retained.has(name) || !references.has(name)) continue;
      retained.add(name);
      changed = true;
      for (const reference of referencedNames([declaration])) references.add(reference);
    }
  }
  const dropped = (name: string) =>
    name === appName || (usedSchemas.has(name) && !retained.has(name));

  return body
    .flatMap(statement => {
      if (isCompilerImport(statement)) {
        const clause = statement.importClause;
        const bindings = clause?.namedBindings;
        if (!clause || !bindings || !ts.isNamedImports(bindings)) return [];
        const kept = bindings.elements.filter(element => references.has(element.name.text));
        if (!kept.length) return [];
        const typeOnly = clause.phaseModifier === ts.SyntaxKind.TypeKeyword;
        const names = kept.map(element => {
          const alias = element.propertyName ? `${element.propertyName.text} as ` : "";
          return `${!typeOnly && element.isTypeOnly ? "type " : ""}${alias}${element.name.text}`;
        });
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        return [
          `import ${typeOnly ? "type " : ""}{ ${names.join(", ")} } from ${JSON.stringify(specifier)};`,
        ];
      }
      if (ts.isVariableStatement(statement)) {
        const declarations = statement.declarationList.declarations.filter(
          declaration =>
            !(ts.isIdentifier(declaration.name) && dropped(declaration.name.text)),
        );
        if (declarations.length !== statement.declarationList.declarations.length) {
          if (!declarations.length) return [];
          return [
            print(
              ts.factory.updateVariableStatement(
                statement,
                statement.modifiers,
                ts.factory.updateVariableDeclarationList(
                  statement.declarationList,
                  declarations,
                ),
              ),
            ),
          ];
        }
      }
      return [print(statement)];
    })
    .join("\n");
};

const valueForContextKey = (
  key: string,
  req: string,
  server: string,
  extensions: ReadonlyMap<string, string>,
  convertedParams = false,
) => {
  const extension = extensions.get(key);
  if (extension) return extension;
  if (key === "params") return convertedParams ? "__orvoxParams" : `${req}.params`;
  if (key === "body") return "__orvoxBody";
  if (key === "query") return "__orvoxQuery";
  if (key === "headers") return "__orvoxHeaders";
  if (key === "cookies") return "__orvoxCookies";
  if (key === "server") return server;
  return req;
};

const contextLiteral = (
  route: CompiledRoute,
  req: string,
  server: string,
  extensions: ReadonlyMap<string, string> = new Map(),
) => {
  const properties = [route.paramsSchema ? "params: __orvoxParams" : `params: ${req}.params`];
  if (route.needs.body) properties.push("body: __orvoxBody");
  if (route.needs.query) properties.push("query: __orvoxQuery");
  if (route.needs.headers) properties.push("headers: __orvoxHeaders");
  if (route.needs.cookies) properties.push("cookies: __orvoxCookies");
  if (route.needs.rawRequest) properties.push(`request: ${req}`);
  if (route.needs.server) properties.push(`server: ${server}`);
  for (const [name, value] of extensions) {
    properties.push(`${JSON.stringify(name)}: ${value}`);
  }
  return `{ ${properties.join(", ")} }`;
};

const bindingInfo = (
  handler: HandlerNode,
  route: CompiledRoute,
  extensions: ReadonlyMap<string, string> = new Map(),
) => {
  const parameter = handler.parameters[0];
  if (!parameter) {
    return { lines: [] as string[], context: "", req: "req", server: "server" };
  }
  if (ts.isIdentifier(parameter.name)) {
    const req = parameter.name.text === "req" ? "__orvoxRequest" : "req";
    const server = parameter.name.text === "server" ? "__orvoxServer" : "server";
    const context = contextLiteral(route, req, server, extensions);
    return {
      lines: [`const ${parameter.name.text} = ${context};`],
      context,
      req,
      server,
    };
  }
  if (!ts.isObjectBindingPattern(parameter.name)) {
    throw new CompileError(
      "ORVOX_UNSUPPORTED_CONTEXT",
      "Handler context must be an object binding pattern or identifier.",
    );
  }
  const pattern = parameter.name;
  const names = new Set(
    pattern.elements
      .map(element => (ts.isIdentifier(element.name) ? element.name.text : ""))
      .filter(Boolean),
  );
  const req = names.has("req") ? "__orvoxRequest" : "req";
  const server = names.has("server") ? "__orvoxServer" : "server";
  const lines: string[] = [];
  const properties: string[] = [];
  for (const element of pattern.elements) {
    const key = element.propertyName ?? element.name;
    const keyText =
      ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : "";
    const local = (element.name as ts.Identifier).text;
    const value = valueForContextKey(keyText, req, server, extensions, !!route.paramsSchema);
    lines.push(`const ${local} = ${value};`);
    properties.push(`${JSON.stringify(keyText)}: ${value}`);
  }
  return {
    lines,
    context: `{ ${properties.join(", ")} }`,
    req,
    server,
  };
};

const requestPrelude = (route: CompiledRoute, req: string, headers = "") => {
  const suffix = headers ? `, ${headers}` : "";
  const lines: string[] = [];
  if (route.needs.body) {
    if (route.schema) {
      lines.push(`const __orvoxContentType = ${req}.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();`);
      lines.push(`if (__orvoxContentType !== "application/json" && !__orvoxContentType?.endsWith("+json")) return __orvoxValidationError("$", "invalid_content_type", "Expected application/json content type."${suffix});`);
    }
    lines.push(`let __orvoxBody: ${route.schema ? "any" : "unknown"};`);
    lines.push("try {");
    lines.push(`  __orvoxBody = await ${req}.json();`);
    lines.push("} catch {");
    lines.push(route.schema
      ? `  return __orvoxValidationError("$", "invalid_json", "Request body must be valid JSON."${suffix});`
      : `  return __orvoxInvalidJson(${headers});`);
    lines.push("}");
    if (route.schema) lines.push(...emitValidation(route.schema, "__orvoxBody", headers));
  }
  if (route.paramsSchema) {
    lines.push(...emitStringMapValidation(
      route.paramsSchema,
      "__orvoxParams",
      name => `${req}.params[${JSON.stringify(name)}]`,
      headers,
      "path param",
    ));
  }
  if (route.needs.query) {
    if (route.querySchema) {
      lines.push(`const __orvoxSearch = new URL(${req}.url).searchParams;`);
      lines.push(...emitStringMapValidation(
        route.querySchema,
        "__orvoxQuery",
        name => `__orvoxSearch.get(${JSON.stringify(name)})`,
        headers,
      ));
    } else {
      lines.push(
        `const __orvoxQuery = Object.fromEntries(new URL(${req}.url).searchParams) as Record<string, string>;`,
      );
    }
  }
  if (route.needs.headers) {
    if (route.needs.headers.includes("*")) {
      lines.push(
        `const __orvoxHeaders = Object.fromEntries(${req}.headers) as Record<string, string>;`,
      );
    } else {
      const entries = route.needs.headers.map(
        name => `${JSON.stringify(name)}: ${req}.headers.get(${JSON.stringify(name)})`,
      );
      lines.push(`const __orvoxHeaders = { ${entries.join(", ")} };`);
    }
  }
  if (route.needs.cookies) lines.push(`const __orvoxCookies = ${req}.cookies;`);
  return lines;
};

const responseHeaders = (route: CompiledRoute) => {
  const headers = new Map<string, string>();
  for (const middleware of route.middlewareNodes) {
    if (middleware.kind === "header") headers.set(middleware.name, middleware.value);
  }
  return headers;
};

const setResponseHeaders = (
  response: string,
  headers: ReadonlyMap<string, string>,
  spaces = "",
) => [...headers].map(
  ([name, value]) => `${spaces}${response}.headers.set(${JSON.stringify(name)}, ${JSON.stringify(value)});`,
);

const generateMiddlewarePrelude = (
  route: CompiledRoute,
  req: string,
  server: string,
  print: (node: ts.Node) => string,
) => {
  const lines: string[] = [];
  const extensions = new Map<string, string>();
  const headers = responseHeaders(route);
  let index = 0;
  for (const middleware of route.middlewareNodes) {
    if (middleware.kind === "header") continue;
    const context = contextLiteral(route, req, server, extensions);
    if (middleware.kind === "guard") {
      const result = `__orvoxGuard${index++}`;
      lines.push(`const ${result} = await (${print(middleware.handler)})(${context});`);
      lines.push(`if (${result} instanceof Response) {`);
      lines.push(...setResponseHeaders(result, headers, "  "));
      lines.push(`  return ${result};`);
      lines.push("}");
      continue;
    }
    const result = `__orvoxDerived${index++}`;
    lines.push(`const ${result} = await (${print(middleware.handler)})(${context});`);
    for (const key of middleware.keys) {
      const value = `__orvoxExtension${index++}`;
      lines.push(`const ${value} = ${result}[${JSON.stringify(key)}];`);
      extensions.set(key, value);
    }
  }
  return { lines, extensions };
};

const methodArguments = (
  route: CompiledRoute,
  req: string,
  server: string,
) => {
  const usesRequest =
    route.raw ||
    route.handler.parameters.length > 0 ||
    route.needs.rawRequest ||
    route.needs.body ||
    route.needs.query ||
    !!route.needs.headers ||
    route.needs.cookies ||
    route.middlewareNodes.some(middleware => middleware.kind !== "header") ||
    route.params.length > 0;
  const usesServer = route.raw
    ? route.handler.parameters.length > 1
    : route.needs.server;
  if (usesServer) return `${req}, ${server}`;
  return usesRequest ? req : "";
};

const generateRouteMethod = (
  route: CompiledRoute,
  sourceFile: ts.SourceFile,
  onRequest?: HandlerNode,
) => {
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const print = (node: ts.Node) =>
    printer.printNode(ts.EmitHint.Expression, node, sourceFile);
  const headers = responseHeaders(route);
  const headersLiteral = headers.size ? JSON.stringify(Object.fromEntries(headers)) : "";
  const headerOptions = headersLiteral ? `, { headers: ${headersLiteral} }` : "";

  if (route.responseMode === "static" && !onRequest && !ts.isBlock(route.handler.body)) {
    const expression = unwrap(route.handler.body);
    const value = isTextExpression(expression)
      ? `new Response(${print(expression)}${headerOptions})`
      : `Response.json(${print(expression)}${headerOptions})`;
    return {
      code: `${route.method}: ${value},`,
      needsHelper: false,
      needsInvalidJson: false,
      needsValidation: false,
    };
  }
  if (route.raw) {
    if (onRequest) {
      const args = route.handler.parameters.length > 1 ? "req, server" : "req";
      return {
        code: [
          `async ${route.method}(${args}) {`,
          `  await (${print(onRequest)})(req);`,
          `  return (${print(route.handler)})(${args});`,
          "},",
        ].join("\n"),
        needsHelper: false,
        needsInvalidJson: false,
        needsValidation: false,
      };
    }
    return {
      code: `${route.method}: ${print(route.handler)},`,
      needsHelper: false,
      needsInvalidJson: false,
      needsValidation: false,
    };
  }

  const baseBinding = bindingInfo(route.handler, route);
  const middleware = generateMiddlewarePrelude(
    route,
    baseBinding.req,
    baseBinding.server,
    print,
  );
  const binding = bindingInfo(route.handler, route, middleware.extensions);
  const args = methodArguments(route, binding.req, binding.server) || (onRequest ? binding.req : "");
  const prelude = requestPrelude(route, binding.req, headersLiteral);
  const hookPrelude = onRequest
    ? [`await (${print(onRequest)})(${binding.req});`]
    : [];
  const finish = (response: string) => {
    if (!headers.size) return [`return ${response};`];
    return [
      `const __orvoxOutput = ${response};`,
      ...setResponseHeaders("__orvoxOutput", headers),
      "return __orvoxOutput;",
    ];
  };
  if (ts.isBlock(route.handler.body)) {
    const callArg = route.handler.parameters.length ? binding.context : "";
    return {
      code: [
        `async ${route.method}(${args}) {`,
        ...hookPrelude.map(line => `  ${line}`),
        ...prelude.map(line => `  ${line}`),
        ...middleware.lines.map(line => `  ${line}`),
        ...finish(`__orvoxResponse(await (${print(route.handler)})(${callArg}))`).map(line => `  ${line}`),
        "},",
      ].join("\n"),
      needsHelper: true,
      needsInvalidJson: route.needs.body && !route.schema,
      needsValidation: !!route.schema || !!route.querySchema || !!route.paramsSchema,
    };
  }

  const expression = unwrap(route.handler.body);
  const responseMode = route.responseMode === "static"
    ? (isTextExpression(expression) ? "text" : "json")
    : route.responseMode;
  const asyncHandler = !!route.handler.modifiers?.some(
    modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword,
  );
  const unknown = responseMode === "dynamic";
  const isAsync =
    asyncHandler ||
    unknown ||
    route.needs.body ||
    !!onRequest ||
    route.middlewareNodes.some(item => item.kind !== "header");
  const value = asyncHandler ? `await (${print(expression)})` : print(expression);
  const response =
    responseMode === "response"
      ? value
      : responseMode === "text"
        ? `new Response(${value})`
        : responseMode === "json"
          ? `Response.json(${value})`
          : `__orvoxResponse(await (${print(expression)}))`;
  return {
    code: [
      `${isAsync ? "async " : ""}${route.method}(${args}) {`,
      ...hookPrelude.map(line => `  ${line}`),
      ...prelude.map(line => `  ${line}`),
      ...middleware.lines.map(line => `  ${line}`),
      ...binding.lines.map(line => `  ${line}`),
      ...finish(response).map(line => `  ${line}`),
      "},",
    ].join("\n"),
    needsHelper: unknown,
    needsInvalidJson: route.needs.body && !route.schema,
    needsValidation: !!route.schema || !!route.querySchema || !!route.paramsSchema,
  };
};

const indent = (value: string, spaces: number) => {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map(line => `${prefix}${line}`)
    .join("\n");
};

const fallbackCondition = (path: string) => {
  if (!pathParams(path).length) return `path === ${JSON.stringify(path)}`;
  const pattern = path
    .split("/")
    .map(segment =>
      segment.startsWith(":")
        ? "[^/]+"
        : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("\\/");
  return `/^${pattern}$/.test(path)`;
};

const allowedMethods = (routes: Array<{ method: HttpMethod }>) => {
  const methods = new Set<string>(routes.map(route => route.method));
  if (methods.has("GET")) methods.add("HEAD");
  methods.add("OPTIONS");
  return ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]
    .filter(method => methods.has(method))
    .join(", ");
};

const compareFallbackPaths = (left: string, right: string) => {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  for (let index = 0; index < Math.min(leftSegments.length, rightSegments.length); index++) {
    const leftParam = leftSegments[index]!.startsWith(":");
    const rightParam = rightSegments[index]!.startsWith(":");
    if (leftParam !== rightParam) return leftParam ? 1 : -1;
  }
  return 0;
};

const generateOpenAPI = (routes: CompiledRoute[], info: OpenAPIDocument["info"]): OpenAPIDocument => {
  const paths: OpenAPIDocument["paths"] = {};
  for (const route of routes) {
    const path = route.path.replace(/:([A-Za-z_$][\w$]*)/g, "{$1}");
    const operation: Record<string, unknown> = {};
    if (route.params.length) {
      operation.parameters = route.params.map(name => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }
    if (route.schema) {
      operation.requestBody = {
        required: true,
        content: {
          "application/json": { schema: schemaToOpenAPI(route.schema) },
        },
      };
    }
    operation.responses = {
      "200": { description: "Successful response" },
      ...(route.schema ? { "400": { description: "Validation failed" } } : {}),
    };
    (paths[path] ??= {})[route.method.toLowerCase()] = operation;
  }
  return {
    openapi: "3.1.0",
    info,
    paths,
  };
};

const generateCode = (
  routes: CompiledRoute[],
  websockets: CompiledWebSocketRoute[],
  hooks: RuntimeHooks,
  sourceFile: ts.SourceFile,
  retained: string,
  globalHeaders: ReadonlyMap<string, string>,
) => {
  const globalHeaderLiteral = globalHeaders.size
    ? JSON.stringify(Object.fromEntries(globalHeaders))
    : "";
  const globalSpread = globalHeaderLiteral ? "...__orvoxGlobalHeaders, " : "";
  const globalOption = globalHeaderLiteral ? ", headers: __orvoxGlobalHeaders" : "";
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const print = (node: ts.Node) =>
    printer.printNode(ts.EmitHint.Expression, node, sourceFile);
  const groups = new Map<string, CompiledRoute[]>();
  for (const route of routes) {
    const group = groups.get(route.path) ?? [];
    group.push(route);
    groups.set(route.path, group);
  }
  let needsHelper = false;
  let needsInvalidJson = false;
  let needsValidation = false;
  const routeLines: string[] = [];
  const websocketByPath = new Map(websockets.map((route, index) => [route.path, { route, index }]));
  const routePaths = [...groups.keys()];
  for (const path of websocketByPath.keys()) {
    if (!groups.has(path)) routePaths.push(path);
  }
  for (const path of routePaths) {
    const group = groups.get(path) ?? [];
    routeLines.push(`    ${JSON.stringify(path)}: {`);
    for (const route of group) {
      const generated = generateRouteMethod(route, sourceFile, hooks.onRequest);
      needsHelper ||= generated.needsHelper;
      needsInvalidJson ||= generated.needsInvalidJson;
      needsValidation ||= generated.needsValidation;
      routeLines.push(indent(generated.code, 6));
    }
    const websocket = websocketByPath.get(path);
    if (websocket) {
      const async = hooks.onRequest ? "async " : "";
      routeLines.push(`      ${async}GET(req, server) {`);
      if (hooks.onRequest) routeLines.push(`        await (${print(hooks.onRequest)})(req);`);
      routeLines.push(`        if (server.upgrade(req, { data: { route: ${websocket.index} } })) return;`);
      routeLines.push(`        return new Response("WebSocket Upgrade Required", { status: 426 });`);
      routeLines.push("      },");
    }
    routeLines.push("    },");
  }
  const fallbackLines: string[] = [
    `  ${hooks.onRequest ? "async " : ""}fetch(req) {`,
  ];
  if (hooks.onRequest) fallbackLines.push(`    await (${print(hooks.onRequest)})(req);`);
  fallbackLines.push("    const path = new URL(req.url).pathname;");
  const fallbackMap = new Map<string, Array<{ method: HttpMethod }>>(
    [...groups].map(([path, group]) => [path, group]),
  );
  for (const websocket of websockets) {
    const group = fallbackMap.get(websocket.path) ?? [];
    group.push({ method: "GET" });
    fallbackMap.set(websocket.path, group);
  }
  const fallbackGroups = [...fallbackMap].sort(([left], [right]) =>
    compareFallbackPaths(left, right),
  );
  for (const [path, group] of fallbackGroups) {
    fallbackLines.push(`    if (${fallbackCondition(path)}) {`);
    fallbackLines.push(`      const allow = ${JSON.stringify(allowedMethods(group))};`);
    fallbackLines.push('      if (req.method === "OPTIONS") {');
    fallbackLines.push(
      `        return new Response(null, { status: 204, headers: { ${globalSpread}allow } });`,
    );
    fallbackLines.push("      }");
    fallbackLines.push('      return new Response("Method Not Allowed", {');
    fallbackLines.push("        status: 405,");
    fallbackLines.push(`        headers: { ${globalSpread}allow },`);
    fallbackLines.push("      });");
    fallbackLines.push("    }");
  }
  fallbackLines.push(`    return new Response("Not Found", { status: 404${globalOption} });`);
  fallbackLines.push("  },");

  const websocketLines: string[] = [];
  if (websockets.length) {
    const event = (
      name: "open" | "message" | "close",
      parameters: string,
      argumentList: string,
    ) => {
      const handlers = websockets
        .map((route, index) => ({ handler: route[name], index }))
        .filter((item): item is { handler: HandlerNode; index: number } => !!item.handler);
      if (!handlers.length) return;
      websocketLines.push(`    ${name}(${parameters}) {`);
      websocketLines.push("      switch (ws.data.route) {");
      for (const { handler, index } of handlers) {
        websocketLines.push(`        case ${index}: return (${print(handler)})(${argumentList});`);
      }
      websocketLines.push("      }");
      websocketLines.push("    },");
    };
    websocketLines.push("  websocket: {");
    websocketLines.push("    data: {} as { route: number },");
    event("open", "ws", "ws");
    event("message", "ws, message", "ws, message");
    event("close", "ws, code, reason", "ws, code, reason");
    websocketLines.push("  },");
  }

  const blocks = ["// Generated by ORVOX. Do not edit."];
  if (retained) blocks.push(retained);
  if (globalHeaderLiteral) {
    blocks.push(`const __orvoxGlobalHeaders: Record<string, string> = ${globalHeaderLiteral};`);
  }
  needsHelper ||= !!hooks.onError;
  if (needsHelper) {
    blocks.push(`function __orvoxResponse(value: unknown): Response {
  if (value instanceof Response) return value;
  if (typeof value === "string") return new Response(value);
  return Response.json(value);
}`);
  }
  if (needsInvalidJson) {
    blocks.push(`function __orvoxInvalidJson(headers?: Record<string, string>): Response {
  return Response.json({
    error: "INVALID_JSON",
    issues: [{ path: "$", code: "invalid_json", message: "Request body must be valid JSON." }],
  }, { status: 400, headers });
}`);
  }
  if (needsValidation) {
    blocks.push(`function __orvoxValidationError(path: string, code: string, message: string, headers?: Record<string, string>): Response {
  return Response.json({ error: "VALIDATION_FAILED", issues: [{ path, code, message }] }, { status: 400, headers });
}`);
  }
  const errorHandler = hooks.onError
    ? `  async error(error) {
    try {
      const __orvoxOutput = __orvoxResponse(await (${print(hooks.onError)})(error));
${[...setResponseHeaders("__orvoxOutput", globalHeaders, "      "), "      return __orvoxOutput;"].join("\n")}
    } catch {
      return new Response("Internal Server Error", { status: 500${globalOption} });
    }
  },`
    : `  error() {
    return new Response("Internal Server Error", { status: 500${globalOption} });
  },`;
  blocks.push(`export const server = Bun.serve({
  hostname: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  development: false,
  maxRequestBodySize: ${hooks.maxRequestBodySize},
${errorHandler}
${websocketLines.join("\n")}
  routes: {
${routeLines.join("\n")}
  },
${fallbackLines.join("\n")}
});`);
  const shutdown = hooks.onStop
    ? `    try {
      await (${print(hooks.onStop)})(server);
    } finally {
      await server.stop();
    }`
    : "    await server.stop();";
  blocks.push(`if (import.meta.main) {
  console.log(\`ORVOX listening on \${server.url}\`);
  let __orvoxStopping = false;
  const __orvoxShutdown = async () => {
    if (__orvoxStopping) return;
    __orvoxStopping = true;
${shutdown}
  };
  process.once("SIGINT", __orvoxShutdown);
  process.once("SIGTERM", __orvoxShutdown);
}`);
  return `${blocks.join("\n\n")}\n`;
};

export function compileSource(
  source: string,
  options: CompileSourceOptions,
): CompileResult {
  const entryPath = options.entryPath;
  const outputPath = options.outputPath ?? ".orvox/server.generated.ts";
  const sourceFile = ts.createSourceFile(
    entryPath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const parseDiagnostics = (
    sourceFile as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }
  ).parseDiagnostics;
  if (parseDiagnostics?.length) {
    throw new CompileError(
      "ORVOX_PARSE_ERROR",
      ts.flattenDiagnosticMessageText(parseDiagnostics[0]!.messageText, "\n"),
    );
  }

  const appName = findAppName(sourceFile);
  const warnings: AnalysisWarning[] = [];
  const { routes, globalHeaders, usedSchemas } = parseRoutes(sourceFile, appName, warnings);
  const { hooks, websockets } = parseRuntime(sourceFile, appName);
  if (!routes.length && !websockets.length) {
    throw new CompileError("ORVOX_ROUTE_REQUIRED", "No routes were found.");
  }
  for (const websocket of websockets) {
    if (routes.some(route => route.path === websocket.path && route.method === "GET")) {
      throw new CompileError(
        "ORVOX_DUPLICATE_ROUTE",
        `Duplicate route: GET "${websocket.path}".`,
      );
    }
  }
  const printedNodes: ts.Node[] = [
    ...routes.flatMap(route => [
      route.handler,
      ...route.middlewareNodes.flatMap(middleware =>
        middleware.kind === "header" ? [] : [middleware.handler],
      ),
    ]),
    ...websockets.flatMap(socket =>
      [socket.open, socket.message, socket.close].filter(handler => !!handler),
    ),
    ...[hooks.onRequest, hooks.onError, hooks.onStop].filter(handler => !!handler),
  ];
  const retained = retainedSource(
    sourceFile,
    appName,
    entryPath,
    outputPath,
    usedSchemas,
    printedNodes,
  );
  const manifestRoutes = routes.map(
    ({ handler: _handler, raw: _raw, middlewareNodes: _middlewareNodes, ...route }) => route,
  );
  const normalizedEntry = slash(relative(process.cwd(), entryPath));
  const openapi = generateOpenAPI(routes, hooks.openapi);
  return {
    code: generateCode(routes, websockets, hooks, sourceFile, retained, globalHeaders),
    manifest: { version: 1, entry: normalizedEntry, routes: manifestRoutes },
    analysis: { version: 1, entry: normalizedEntry, warnings },
    openapi,
  };
}

export async function compile(
  entryPath: string,
  options: { outDir?: string } = {},
): Promise<CompileFilesResult> {
  const absoluteEntry = resolve(entryPath);
  const outDir = resolve(options.outDir ?? ".orvox");
  const serverPath = resolve(outDir, "server.generated.ts");
  const manifestPath = resolve(outDir, "routes.manifest.json");
  const analysisPath = resolve(outDir, "analysis.json");
  const openapiPath = resolve(outDir, "openapi.json");
  const source = await readFile(absoluteEntry, "utf8");
  const result = compileSource(source, {
    entryPath: absoluteEntry,
    outputPath: serverPath,
  });
  await mkdir(outDir, { recursive: true });
  await Promise.all([
    writeFile(serverPath, result.code, "utf8"),
    writeFile(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`, "utf8"),
    writeFile(analysisPath, `${JSON.stringify(result.analysis, null, 2)}\n`, "utf8"),
    writeFile(openapiPath, `${JSON.stringify(result.openapi, null, 2)}\n`, "utf8"),
  ]);
  return { ...result, serverPath, manifestPath, analysisPath, openapiPath };
}
