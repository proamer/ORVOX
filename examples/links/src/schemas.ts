import { t, type Infer } from "@orvox/core";

// A link is either an external URL or a pointer at another code, and the two
// carry different fields. The tag is what the compiler switches on.
export const NewLink = t.union("kind", [
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

export const Link = t.object({
  code: t.string(),
  target: t.string(),
  kind: t.enum(["url", "alias"]),
  hits: t.int(),
  createdAt: t.int(),
});

export type Link = Infer<typeof Link>;

export const ListQuery = t.object({
  after: t.optional(t.string({ min: 1, max: 7 })),
  limit: t.optional(t.int({ min: 1, max: 100 })),
  kind: t.optional(t.enum(["url", "alias"])),
});

export const Code = t.object({ code: t.string({ min: 7, max: 7 }) });
