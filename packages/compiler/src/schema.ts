import ts from "typescript";

export type SchemaIR =
  | { kind: "string"; min?: number; max?: number }
  | { kind: "integer"; min?: number; max?: number }
  | { kind: "number"; min?: number; max?: number }
  | { kind: "boolean" }
  | { kind: "literal"; value: string | number | boolean }
  | { kind: "enum"; values: Array<string | number | boolean> }
  | { kind: "union"; tag: string; branches: SchemaIR[] }
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

const literalValue = (input: ts.Expression | undefined) => {
  if (!input) return undefined;
  const node = unwrap(input);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  const value = numberLiteral(node);
  return value !== undefined && Number.isFinite(value) ? value : undefined;
};

const parseBounds = (
  input: ts.Expression | undefined,
  fail: Fail,
  fractional = false,
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
    if (value === undefined || (fractional ? !Number.isFinite(value) : !Number.isInteger(value))) {
      return fail(
        "ORVOX_STATIC_SCHEMA_REQUIRED",
        `Schema option "${name}" must be ${fractional ? "a numeric" : "an integer"} literal.`,
      );
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
  if (method === "number") {
    return { kind: "number", ...parseBounds(input.arguments[0], fail, true) };
  }
  if (method === "literal") {
    const value = literalValue(input.arguments[0]);
    if (value === undefined) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "t.literal() requires a string, number, or boolean literal.");
    }
    return { kind: "literal", value };
  }
  if (method === "enum") {
    const list = input.arguments[0] && unwrap(input.arguments[0]);
    if (!list || !ts.isArrayLiteralExpression(list)) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "t.enum() requires an array literal.");
    }
    const values: Array<string | number | boolean> = [];
    for (const element of list.elements) {
      const value = literalValue(element);
      if (value === undefined) {
        return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "t.enum() values must be string, number, or boolean literals.");
      }
      if (values.includes(value)) return fail("ORVOX_SCHEMA_OPTION", "t.enum() values must be distinct.");
      values.push(value);
    }
    if (!values.length) return fail("ORVOX_SCHEMA_OPTION", "t.enum() requires at least one value.");
    return { kind: "enum", values };
  }
  if (method === "union") {
    const tag = input.arguments[0] && unwrap(input.arguments[0]);
    if (!tag || !ts.isStringLiteralLike(tag)) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "t.union() requires a string literal tag.");
    }
    const list = input.arguments[1] && unwrap(input.arguments[1]);
    if (!list || !ts.isArrayLiteralExpression(list)) {
      return fail("ORVOX_STATIC_SCHEMA_REQUIRED", "t.union() requires an array literal of branches.");
    }
    const branches = list.elements.map(element =>
      parseSchemaExpression(element, namespaces, declarations, usedDeclarations, fail, resolving));
    if (branches.length < 2) {
      return fail("ORVOX_SCHEMA_OPTION", "t.union() requires at least two branches.");
    }
    // The tag has to select exactly one branch, or the switch cannot be written.
    const seen = new Set<string>();
    branches.forEach((branch, index) => {
      if (branch.kind !== "object") {
        fail("ORVOX_SCHEMA_OPTION", `Union branch ${index + 1} must be a t.object().`);
        return;
      }
      const property = branch.properties.find(item => item.name === tag.text);
      if (!property || !property.required || property.schema.kind !== "literal") {
        fail(
          "ORVOX_SCHEMA_OPTION",
          `Union branch ${index + 1} must set ${JSON.stringify(tag.text)} to a literal so the tag can select it.`,
        );
        return;
      }
      const key = JSON.stringify(property.schema.value);
      if (seen.has(key)) {
        fail("ORVOX_SCHEMA_OPTION", `Union branches ${JSON.stringify(tag.text)} values must be distinct.`);
      }
      seen.add(key);
    });
    return { kind: "union", tag: tag.text, branches };
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
    if (current.kind === "number") {
      const lines = [
        `if (typeof ${currentValue} !== "number" || !Number.isFinite(${currentValue})) ${invalid(path, "invalid_type", "Expected a number.")}`,
      ];
      if (current.min !== undefined) lines.push(`if ((${currentValue} as number) < ${current.min}) ${invalid(path, "min_value", `Expected a value greater than or equal to ${current.min}.`)}`);
      if (current.max !== undefined) lines.push(`if ((${currentValue} as number) > ${current.max}) ${invalid(path, "max_value", `Expected a value less than or equal to ${current.max}.`)}`);
      return lines;
    }
    if (current.kind === "boolean") {
      return [`if (typeof ${currentValue} !== "boolean") ${invalid(path, "invalid_type", "Expected a boolean.")}`];
    }
    if (current.kind === "literal") {
      return [
        `if (${currentValue} !== ${JSON.stringify(current.value)}) ${invalid(path, "invalid_value", `Expected ${JSON.stringify(current.value)}.`)}`,
      ];
    }
    if (current.kind === "enum") {
      const allowed = current.values.map(value => JSON.stringify(value));
      return [
        `if (!${JSON.stringify(current.values)}.includes(${currentValue} as never)) ${invalid(path, "invalid_value", `Expected one of ${allowed.join(", ")}.`)}`,
      ];
    }
    if (current.kind === "union") {
      // Switching on the tag is what lets a failure be reported against the one
      // branch the tag chose, instead of a pile of "none of these matched".
      const tagPath = `${path} + ${JSON.stringify(propertyPath(current.tag))}`;
      const tagValue = `(${currentValue} as Record<string, unknown>)[${JSON.stringify(current.tag)}]`;
      const tags = current.branches.map(branch => {
        const property = branch.kind === "object"
          ? branch.properties.find(item => item.name === current.tag)
          : undefined;
        return property && property.schema.kind === "literal" ? property.schema.value : undefined;
      });
      const lines = [
        `if (${currentValue} === null || typeof ${currentValue} !== "object" || Array.isArray(${currentValue})) ${invalid(path, "invalid_type", "Expected an object.")}`,
        `switch (${tagValue}) {`,
      ];
      current.branches.forEach((branch, index) => {
        lines.push(`  case ${JSON.stringify(tags[index])}: {`);
        lines.push(...emit(branch, currentValue, path).map(line => `    ${line}`));
        lines.push("    break;");
        lines.push("  }");
      });
      const allowed = tags.map(value => JSON.stringify(value));
      lines.push(`  default: ${invalid(tagPath, "invalid_value", `Expected one of ${allowed.join(", ")}.`)}`);
      lines.push("}");
      return lines;
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
  if (schema.kind === "number") {
    return {
      type: "number",
      ...(schema.min === undefined ? {} : { minimum: schema.min }),
      ...(schema.max === undefined ? {} : { maximum: schema.max }),
    };
  }
  if (schema.kind === "literal") return { const: schema.value };
  if (schema.kind === "enum") return { enum: [...schema.values] };
  if (schema.kind === "union") {
    return {
      oneOf: schema.branches.map(schemaToOpenAPI),
      discriminator: { propertyName: schema.tag },
    };
  }
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

/**
 * Query and path values arrive as strings, so a declared `t.int()` there can
 * only mean "parse this". Bodies are JSON and keep their own types, so
 * `emitValidation` above never coerces. Position decides, not a separate
 * builder.
 *
 * Unlike bodies, a string map is left open: undeclared parameters are ignored
 * rather than rejected. Nothing undeclared reaches the handler either way, and
 * rejecting them would break on every `utm_source` in the wild.
 */
export function emitStringMapValidation(
  schema: SchemaIR,
  target: string,
  read: (name: string) => string,
  headers = "",
  label = "query parameter",
) {
  if (schema.kind !== "object") {
    throw new Error("String map schemas must be objects.");
  }
  const suffix = headers ? `, ${headers}` : "";
  const invalid = (name: string, code: string, message: string) =>
    `return __orvoxValidationError(${JSON.stringify(`$.${name}`)}, ${JSON.stringify(code)}, ${JSON.stringify(message)}${suffix});`;

  // Built loose, then handed over under the type the schema describes -- the
  // handler destructures this, so `Record<string, unknown>` would make every
  // converted value `unknown` in the file that gets type-checked.
  const accumulator = `${target}__raw`;
  const lines = [`const ${accumulator}: Record<string, unknown> = {};`];
  for (const property of schema.properties) {
    // parseSchemaExpression already unwraps t.optional() into required:false,
    // so property.schema is the primitive itself.
    const inner = property.schema;
    if (!["string", "integer", "number", "boolean", "literal", "enum"].includes(inner.kind)) {
      throw new Error(`A ${label} must be a primitive, literal, or enum.`);
    }
    const raw = `__orvoxRaw_${property.name.replace(/[^\w$]/g, "_")}`;
    const body: string[] = [];

    if (inner.kind === "string") {
      if (inner.min !== undefined) {
        body.push(`if (${raw}.length < ${inner.min}) ${invalid(property.name, "min_length", `Expected at least ${inner.min} character${inner.min === 1 ? "" : "s"}.`)}`);
      }
      if (inner.max !== undefined) {
        body.push(`if (${raw}.length > ${inner.max}) ${invalid(property.name, "max_length", `Expected at most ${inner.max} character${inner.max === 1 ? "" : "s"}.`)}`);
      }
      body.push(`${accumulator}[${JSON.stringify(property.name)}] = ${raw};`);
    } else if (inner.kind === "integer") {
      const number = `${raw}_n`;
      body.push(`const ${number} = Number(${raw});`);
      body.push(`if (${raw}.trim() === "" || !Number.isInteger(${number})) ${invalid(property.name, "invalid_type", "Expected an integer.")}`);
      if (inner.min !== undefined) body.push(`if (${number} < ${inner.min}) ${invalid(property.name, "min_value", `Expected a value greater than or equal to ${inner.min}.`)}`);
      if (inner.max !== undefined) body.push(`if (${number} > ${inner.max}) ${invalid(property.name, "max_value", `Expected a value less than or equal to ${inner.max}.`)}`);
      body.push(`${accumulator}[${JSON.stringify(property.name)}] = ${number};`);
    } else if (inner.kind === "number") {
      const number = `${raw}_n`;
      body.push(`const ${number} = Number(${raw});`);
      body.push(`if (${raw}.trim() === "" || !Number.isFinite(${number})) ${invalid(property.name, "invalid_type", "Expected a number.")}`);
      if (inner.min !== undefined) body.push(`if (${number} < ${inner.min}) ${invalid(property.name, "min_value", `Expected a value greater than or equal to ${inner.min}.`)}`);
      if (inner.max !== undefined) body.push(`if (${number} > ${inner.max}) ${invalid(property.name, "max_value", `Expected a value less than or equal to ${inner.max}.`)}`);
      body.push(`${accumulator}[${JSON.stringify(property.name)}] = ${number};`);
    } else if (inner.kind === "literal" || inner.kind === "enum") {
      // The wire only carries strings, so each allowed value is matched by the
      // text that would produce it and handed back as the declared type.
      const values = inner.kind === "literal" ? [inner.value] : inner.values;
      const arms = values.map(value => `${raw} === ${JSON.stringify(String(value))}`);
      const named = values.map(value => JSON.stringify(value));
      body.push(`if (!(${arms.join(" || ")})) ${invalid(
        property.name,
        "invalid_value",
        values.length === 1 ? `Expected ${named[0]}.` : `Expected one of ${named.join(", ")}.`,
      )}`);
      const mapped = values
        .map(value => `${raw} === ${JSON.stringify(String(value))} ? ${JSON.stringify(value)}`)
        .join(" : ");
      body.push(`${accumulator}[${JSON.stringify(property.name)}] = ${mapped} : ${raw};`);
    } else {
      body.push(`if (${raw} !== "true" && ${raw} !== "false") ${invalid(property.name, "invalid_type", "Expected true or false.")}`);
      body.push(`${accumulator}[${JSON.stringify(property.name)}] = ${raw} === "true";`);
    }

    lines.push(`{`);
    lines.push(`  const ${raw} = ${read(property.name)};`);
    lines.push(`  if (${raw} === null || ${raw} === undefined) {`);
    lines.push(property.required
      ? `    ${invalid(property.name, "required", `Required ${label} is missing.`)}`
      : `    /* optional */`);
    lines.push(`  } else {`);
    lines.push(...body.map(line => `    ${line}`));
    lines.push(`  }`);
    lines.push(`}`);
  }
  lines.push(`const ${target} = ${accumulator} as ${schemaToTypeText(schema)};`);
  return lines;
}

/**
 * The IR spelled out as a TypeScript type.
 *
 * `type X = Infer<typeof S>` is the documented way to name a body's shape, but
 * it keeps S alive as a value and drags @orvox/core into the deployed file for
 * a type that is erased anyway. The compiler already knows the shape, so it
 * writes it out and lets S go.
 */
export function schemaToTypeText(schema: SchemaIR): string {
  if (schema.kind === "string") return "string";
  if (schema.kind === "integer" || schema.kind === "number") return "number";
  if (schema.kind === "boolean") return "boolean";
  if (schema.kind === "literal") return JSON.stringify(schema.value);
  if (schema.kind === "enum") return schema.values.map(value => JSON.stringify(value)).join(" | ");
  if (schema.kind === "optional") return `${schemaToTypeText(schema.inner)} | undefined`;
  if (schema.kind === "union") {
    return schema.branches.map(branch => `(${schemaToTypeText(branch)})`).join(" | ");
  }
  if (schema.kind === "array") {
    const item = schemaToTypeText(schema.items);
    return /^[A-Za-z0-9_$.]+$/.test(item) ? `${item}[]` : `Array<${item}>`;
  }
  const properties = schema.properties.map(property => {
    const key = /^[A-Za-z_$][\w$]*$/.test(property.name) ? property.name : JSON.stringify(property.name);
    return `${key}${property.required ? "" : "?"}: ${schemaToTypeText(property.schema)}`;
  });
  return properties.length ? `{ ${properties.join("; ")} }` : "{}";
}
