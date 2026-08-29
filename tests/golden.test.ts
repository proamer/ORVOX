import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileSource } from "@orvox/compiler";

test("emits deterministic native Bun routes", () => {
  const source = `
import { orvox } from "@orvox/core"

const app = orvox()

app.get("/", () => "hello")
app.get("/users/:id", ({ params }) => ({ id: params.id }))

export default app
`;
  const expected = readFileSync(
    join(import.meta.dir, "golden", "basic.generated.ts"),
    "utf8",
  );

  const result = compileSource(source, {
    entryPath: "src/app.ts",
    outputPath: ".orvox/server.generated.ts",
  });

  expect(result.code).toBe(expected);
});

