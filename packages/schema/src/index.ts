declare const output: unique symbol;

export interface Schema<Output = unknown> {
  readonly kind: string;
  readonly [output]?: Output;
}

export type AnySchema = Schema<any>;
export type Infer<Value extends AnySchema> =
  Value extends Schema<infer Output> ? Output : never;

export type Bounds = Readonly<{ min?: number; max?: number }>;

export interface StringSchema extends Schema<string>, Bounds {
  readonly kind: "string";
}

export interface IntegerSchema extends Schema<number>, Bounds {
  readonly kind: "integer";
}

export type LiteralValue = string | number | boolean;

export interface NumberSchema extends Schema<number>, Bounds {
  readonly kind: "number";
}

export interface LiteralSchema<Value extends LiteralValue> extends Schema<Value> {
  readonly kind: "literal";
  readonly value: Value;
}

export interface EnumSchema<Values extends readonly LiteralValue[]>
  extends Schema<Values[number]> {
  readonly kind: "enum";
  readonly values: Values;
}

export interface UnionSchema<Branches extends readonly AnySchema[]>
  extends Schema<Infer<Branches[number]>> {
  readonly kind: "union";
  readonly tag: string;
  readonly branches: Branches;
}

export interface BooleanSchema extends Schema<boolean> {
  readonly kind: "boolean";
}

export interface OptionalSchema<Inner extends AnySchema>
  extends Schema<Infer<Inner> | undefined> {
  readonly kind: "optional";
  readonly inner: Inner;
}

export interface ArraySchema<Item extends AnySchema>
  extends Schema<Infer<Item>[]>, Bounds {
  readonly kind: "array";
  readonly items: Item;
}

type OptionalKeys<Shape extends Record<string, AnySchema>> = {
  [Key in keyof Shape]-?: Shape[Key] extends OptionalSchema<AnySchema>
    ? Key
    : never;
}[keyof Shape];

type ObjectOutput<Shape extends Record<string, AnySchema>> = {
  [Key in Exclude<keyof Shape, OptionalKeys<Shape>>]: Infer<Shape[Key]>;
} & {
  [Key in OptionalKeys<Shape>]?: Exclude<Infer<Shape[Key]>, undefined>;
};

export interface ObjectSchema<Shape extends Record<string, AnySchema>>
  extends Schema<ObjectOutput<Shape>> {
  readonly kind: "object";
  readonly properties: Readonly<Shape>;
}

const bounds = (options: Bounds | undefined, fractional = false) => {
  if (!options) return {};
  for (const value of [options.min, options.max]) {
    if (value === undefined) continue;
    if (fractional ? !Number.isFinite(value) : !Number.isInteger(value)) {
      throw new TypeError(
        fractional
          ? "Schema bounds must be finite numbers."
          : "Schema bounds must be finite integers.",
      );
    }
  }
  if (options.min !== undefined && options.max !== undefined && options.min > options.max) {
    throw new RangeError("Schema min cannot exceed max.");
  }
  return { ...(options.min === undefined ? {} : { min: options.min }), ...(options.max === undefined ? {} : { max: options.max }) };
};

export const t = Object.freeze({
  string(options?: Bounds): StringSchema {
    return Object.freeze({ kind: "string", ...bounds(options) }) as StringSchema;
  },
  int(options?: Bounds): IntegerSchema {
    return Object.freeze({ kind: "integer", ...bounds(options) }) as IntegerSchema;
  },
  number(options?: Bounds): NumberSchema {
    return Object.freeze({ kind: "number", ...bounds(options, true) }) as NumberSchema;
  },
  boolean(): BooleanSchema {
    return Object.freeze({ kind: "boolean" }) as BooleanSchema;
  },
  literal<const Value extends LiteralValue>(value: Value): LiteralSchema<Value> {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new TypeError("Literal numbers must be finite.");
    }
    return Object.freeze({ kind: "literal", value }) as LiteralSchema<Value>;
  },
  enum<const Values extends readonly LiteralValue[]>(values: Values): EnumSchema<Values> {
    if (!values.length) throw new TypeError("t.enum() requires at least one value.");
    if (new Set(values).size !== values.length) {
      throw new TypeError("t.enum() values must be distinct.");
    }
    return Object.freeze({ kind: "enum", values: Object.freeze([...values]) }) as unknown as EnumSchema<Values>;
  },
  /**
   * A tagged union. The tag is named rather than inferred, so the compiler can
   * emit a switch on it and report a failure against the branch the tag chose
   * instead of against every branch at once.
   */
  union<const Branches extends readonly AnySchema[]>(
    tag: string,
    branches: Branches,
  ): UnionSchema<Branches> {
    if (branches.length < 2) throw new TypeError("t.union() requires at least two branches.");
    return Object.freeze({
      kind: "union",
      tag,
      branches: Object.freeze([...branches]),
    }) as unknown as UnionSchema<Branches>;
  },
  optional<const Inner extends AnySchema>(inner: Inner): OptionalSchema<Inner> {
    return Object.freeze({ kind: "optional", inner }) as OptionalSchema<Inner>;
  },
  array<const Item extends AnySchema>(items: Item, options?: Bounds): ArraySchema<Item> {
    return Object.freeze({ kind: "array", items, ...bounds(options) }) as ArraySchema<Item>;
  },
  object<const Shape extends Record<string, AnySchema>>(shape: Shape): ObjectSchema<Shape> {
    return Object.freeze({
      kind: "object",
      properties: Object.freeze({ ...shape }),
    }) as ObjectSchema<Shape>;
  },
});
