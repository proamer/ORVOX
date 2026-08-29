import ts from "typescript";

export type SchemaIR =
  | { kind: "string"; min?: number; max?: number }
  | { kind: "integer"; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "optional"; inner: SchemaIR }
  | { kind: "array"; items: SchemaIR; min?: number; max?: number }
  | {
      kind: "object";
      properties: Array<{ name: string; required: boolean; schema: SchemaIR }>;
    };

type Fail = (code: string, message: string) => never;

const unwrap = (input: ts.Expression): ts.Expression => {
  while (
    ts.isParenthesizedExpression(input) ||
    ts.isAsExpression(input) ||
    ts.isSatisfiesExpression(input)
  ) {
    input = input.expression;
  }
  return input;
};

const numberLiteral = (input: ts.Expression | undefined) => {
  if (!input) return undefined;
  input = unwrap(input);
  if (ts.isNumericLiteral(input)) return Number(input.text);
  if (
    ts.isPrefixUnaryExpression(input) &&
    ts.isNumericLiteral(input.operand) &&
    [ts.SyntaxKind.MinusToken, ts.SyntaxKind.PlusToken].includes(input.operator)
  ) {
    const value = Number(input.operand.text);
    return input.operator === ts.SyntaxKind.MinusToken ? -value : value;
  }
  return undefined;
};

const parseBounds = (
  input: ts.Expression | undefined,
  fail: Fail,
): { min?: number; max?: number } => {
  if (!input) return {};
  input = unwrap(input);
  if (!ts.isObjectLiteralExpression(input)) {
    return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "Schema options must be object literals.");
  }
  const result: { min?: number; max?: number } = {};
  for (const property of input.properties) {
    if (
      !ts.isPropertyAssignment(property) ||
      (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
    ) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "Schema options must use static properties.");
    }
    const name = property.name.text;
    if (name !== "min" && name !== "max") {
      return fail("ORVOX_SCHEMA_OPTION", `Unsupported schema option "${name}".`);
    }
    const value = numberLiteral(property.initializer);
    if (value === undefined || !Number.isInteger(value)) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", `Schema option "${name}" must be an integer literal.`);
    }
    result[name] = value;
  }
  if (result.min !== undefined && result.max !== undefined && result.min > result.max) {
    return fail("ORVOX_SCHEMA_BOUNDS", "Schema min cannot exceed max.");
  }
  return result;
};

export const schemaNamespaces = (sourceFile: ts.SourceFile) => {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !["@orvox/core", "@orvox/schema"].includes(statement.moduleSpecifier.text)
    ) continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === "t") names.add(element.name.text);
    }
  }
  return names;
};

export const topLevelInitializers = (sourceFile: ts.SourceFile) => {
  const result = new Map<string, ts.Expression>();
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) {
        result.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  return result;
};

export function parseSchemaExpression(
  input: ts.Expression,
  namespaces: ReadonlySet<string>,
  declarations: ReadonlyMap<string, ts.Expression>,
  usedDeclarations: Set<string>,
  fail: Fail,
  resolving = new Set<string>(),
): SchemaIR {
  input = unwrap(input);
  if (ts.isIdentifier(input)) {
    const initializer = declarations.get(input.text);
    if (!initializer) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", `Schema "${input.text}" must be a top-level const.`);
    }
    if (resolving.has(input.text)) {
      return fail("ORVOX_SCHEMA_CYCLE", `Schema "${input.text}" references itself.`);
    }
    usedDeclarations.add(input.text);
    resolving.add(input.text);
    const schema = parseSchemaExpression(
      initializer,
      namespaces,
      declarations,
      usedDeclarations,
      fail,
      resolving,
    );
    resolving.delete(input.text);
    return schema;
  }
  if (
    !ts.isCallExpression(input) ||
    !ts.isPropertyAccessExpression(input.expression) ||
    !ts.isIdentifier(input.expression.expression) ||
    !namespaces.has(input.expression.expression.text)
  ) {
    return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "Schemas must use the imported t builders.");
  }
  const method = input.expression.name.text;
  if (method === "string" || method === "int") {
    const bounds = parseBounds(input.arguments[0], fail);
    return { kind: method === "int" ? "integer" : "string", ...bounds };
  }
  if (method === "boolean") {
    if (input.arguments.length) return fail("ORVOX_SCHEMA_ARGUMENT", "t.boolean() takes no arguments.");
    return { kind: "boolean" };
  }
  if (method === "optional") {
    const inner = input.arguments[0];
    if (!inner) return fail("ORVOX_SCHEMA_ARGUMENT", "t.optional() requires a schema.");
    return {
      kind: "optional",
      inner: parseSchemaExpression(inner, namespaces, declarations, usedDeclarations, fail, resolving),
    };
  }
  if (method === "array") {
    const items = input.arguments[0];
    if (!items) return fail("ORVOX_SCHEMA_ARGUMENT", "t.array() requires an item schema.");
    return {
      kind: "array",
      items: parseSchemaExpression(items, namespaces, declarations, usedDeclarations, fail, resolving),
      ...parseBounds(input.arguments[1], fail),
    };
  }
  if (method === "object") {
    const shape = input.arguments[0] && unwrap(input.arguments[0]);
    if (!shape || !ts.isObjectLiteralExpression(shape)) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "t.object() requires an object literal.");
    }
    const properties: Array<{ name: string; required: boolean; schema: SchemaIR }> = [];
    for (const property of shape.properties) {
      if (
        !ts.isPropertyAssignment(property) ||
        (!ts.isIdentifier(property.name) && !ts.isStringLiteralLike(property.name))
      ) {
        return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "Object schemas must use static property assignments.");
      }
      const name = property.name.text;
      if (properties.some(item => item.name === name)) {
        return fail("ORVOX_SCHEMA_PROPERTY", `Duplicate schema property "${name}".`);
      }
      const schema = parseSchemaExpression(
        property.initializer,
        namespaces,
        declarations,
        usedDeclarations,
        fail,
        resolving,
      );
      properties.push(schema.kind === "optional"
        ? { name, required: false, schema: schema.inner }
        : { name, required: true, schema });
    }
    return { kind: "object", properties };
  }
  return fail("ORVOX_SCHEMA_BUILDER", `Unsupported schema builder "t.${method}".`);
}

const propertyPath = (name: string) =>
  /^[A-Za-z_$][\w$]*$/.test(name) ? `.${name}` : `[${JSON.stringify(name)}]`;

export function emitValidation(schema: SchemaIR, value: string, headers = "") {
  let nextId = 0;
  const suffix = headers ? `, ${headers}` : "";
  const invalid = (path: string, code: string, message: string) =>
    `return __orvoxValidationError(${path}, ${JSON.stringify(code)}, ${JSON.stringify(message)}${suffix});`;
  const emit = (current: SchemaIR, currentValue: string, path: string): string[] => {
    if (current.kind === "string") {
      const lines = [
        `if (typeof ${currentValue} !== "string") ${invalid(path, "invalid_type", "Expected a string.")}`,
      ];
      if (current.min !== undefined) {
        lines.push(`if (${currentValue}.length < ${current.min}) ${invalid(path, "min_length", `Expected at least ${current.min} character${current.min === 1 ? "" : "s"}.`)}`);
      }
      if (current.max !== undefined) {
        lines.push(`if (${currentValue}.length > ${current.max}) ${invalid(path, "max_length", `Expected at most ${current.max} character${current.max === 1 ? "" : "s"}.`)}`);
      }
      return lines;
    }
    if (current.kind === "integer") {
      const lines = [
        `if (!Number.isInteger(${currentValue})) ${invalid(path, "invalid_type", "Expected an integer.")}`,
      ];
      if (current.min !== undefined) lines.push(`if ((${currentValue} as number) < ${current.min}) ${invalid(path, "min_value", `Expected a value greater than or equal to ${current.min}.`)}`);
      if (current.max !== undefined) lines.push(`if ((${currentValue} as number) > ${current.max}) ${invalid(path, "max_value", `Expected a value less than or equal to ${current.max}.`)}`);
      return lines;
    }
    if (current.kind === "boolean") {
      return [`if (typeof ${currentValue} !== "boolean") ${invalid(path, "invalid_type", "Expected a boolean.")}`];
    }
    if (current.kind === "optional") {
      const lines = emit(current.inner, currentValue, path);
      return [`if (${currentValue} !== undefined) {`, ...lines.map(line => `  ${line}`), "}"];
    }
    if (current.kind === "array") {
      const lines = [
        `if (!Array.isArray(${currentValue})) ${invalid(path, "invalid_type", "Expected an array.")}`,
      ];
      if (current.min !== undefined) lines.push(`if (${currentValue}.length < ${current.min}) ${invalid(path, "min_items", `Expected at least ${current.min} item${current.min === 1 ? "" : "s"}.`)}`);
      if (current.max !== undefined) lines.push(`if (${currentValue}.length > ${current.max}) ${invalid(path, "max_items", `Expected at most ${current.max} item${current.max === 1 ? "" : "s"}.`)}`);
      const index = `__orvoxIndex${nextId++}`;
      const item = `__orvoxValue${nextId++}`;
      lines.push(`for (let ${index} = 0; ${index} < ${currentValue}.length; ${index}++) {`);
      lines.push(`  const ${item}: unknown = ${currentValue}[${index}];`);
      lines.push(...emit(current.items, item, `${path} + "[" + ${index} + "]"`).map(line => `  ${line}`));
      lines.push("}");
      return lines;
    }
    const object = `__orvoxValue${nextId++}`;
    const lines = [
      `if (${currentValue} === null || typeof ${currentValue} !== "object" || Array.isArray(${currentValue})) ${invalid(path, "invalid_type", "Expected an object.")}`,
      `const ${object} = ${currentValue} as Record<string, unknown>;`,
    ];
    for (const property of current.properties) {
      const propertyValue = `__orvoxValue${nextId++}`;
      const key = JSON.stringify(property.name);
      const propertyIssuePath = `${path} + ${JSON.stringify(propertyPath(property.name))}`;
      if (property.required) {
        lines.push(`if (!Object.hasOwn(${object}, ${key})) ${invalid(propertyIssuePath, "required", "Required property is missing.")}`);
        lines.push(`const ${propertyValue}: unknown = ${object}[${key}];`);
        lines.push(...emit(property.schema, propertyValue, propertyIssuePath));
      } else {
        lines.push(`if (Object.hasOwn(${object}, ${key}) && ${object}[${key}] !== undefined) {`);
        lines.push(`  const ${propertyValue}: unknown = ${object}[${key}];`);
        lines.push(...emit(property.schema, propertyValue, propertyIssuePath).map(line => `  ${line}`));
        lines.push("}");
      }
    }
    const known = JSON.stringify(current.properties.map(property => property.name));
    const unknownKey = `__orvoxKey${nextId++}`;
    lines.push(`for (const ${unknownKey} of Object.keys(${object})) {`);
    lines.push(`  if (!${known}.includes(${unknownKey})) ${invalid(`${path} + "." + ${unknownKey}`, "unknown_property", "Unknown property is not allowed.")}`);
    lines.push("}");
    return lines;
  };
  return emit(schema, value, JSON.stringify("$"));
}

export function schemaToOpenAPI(schema: SchemaIR): Record<string, unknown> {
  if (schema.kind === "string") {
    return {
      type: "string",
      ...(schema.min === undefined ? {} : { minLength: schema.min }),
      ...(schema.max === undefined ? {} : { maxLength: schema.max }),
    };
  }
  if (schema.kind === "integer") {
    return {
      type: "integer",
      ...(schema.min === undefined ? {} : { minimum: schema.min }),
      ...(schema.max === undefined ? {} : { maximum: schema.max }),
    };
  }
  if (schema.kind === "boolean") return { type: "boolean" };
  if (schema.kind === "optional") return schemaToOpenAPI(schema.inner);
  if (schema.kind === "array") {
    return {
      type: "array",
      items: schemaToOpenAPI(schema.items),
      ...(schema.min === undefined ? {} : { minItems: schema.min }),
      ...(schema.max === undefined ? {} : { maxItems: schema.max }),
    };
  }
  return {
    type: "object",
    properties: Object.fromEntries(
      schema.properties.map(property => [property.name, schemaToOpenAPI(property.schema)]),
    ),
    additionalProperties: false,
    ...(!schema.properties.some(property => property.required)
      ? {}
      : { required: schema.properties.filter(property => property.required).map(property => property.name) }),
  };
}
