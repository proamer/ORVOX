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

const bounds = (options: Bounds | undefined) => {
  if (!options) return {};
  for (const value of [options.min, options.max]) {
    if (value === undefined) continue;
    if (!Number.isInteger(value)) {
      throw new TypeError("Schema bounds must be finite integers.");
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
  boolean(): BooleanSchema {
    return Object.freeze({ kind: "boolean" }) as BooleanSchema;
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
