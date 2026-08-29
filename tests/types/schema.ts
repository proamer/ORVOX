import { orvox, t, type Infer } from "@orvox/core";

const User = t.object({
  name: t.string(),
  age: t.int(),
  active: t.boolean(),
  nickname: t.optional(t.string()),
  tags: t.array(t.string()),
});

const user: Infer<typeof User> = {
  name: "Amp",
  age: 35,
  active: true,
  tags: ["dev"],
};

const app = orvox();
app.post("/users", {
  body: User,
  handler: ({ body }) => {
    const name: string = body.name;
    const nickname: string | undefined = body.nickname;
    const tags: string[] = body.tags;
    return { name, nickname, tags, user };
  },
});

// @ts-expect-error required schema fields stay required
const missing: Infer<typeof User> = { name: "Amp" };
void missing;
