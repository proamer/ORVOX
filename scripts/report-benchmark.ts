import { readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

type Result = {
  workload: string;
  framework: string;
  measurement: { summary?: { requestsPerSec?: number } };
};

const root = join(import.meta.dir, "..");
const outputIndex = process.argv.indexOf("--output");
const output = outputIndex >= 0 ? process.argv[outputIndex + 1] : undefined;
let input = process.argv[2]?.startsWith("--") ? undefined : process.argv[2];

if (!input) {
  const directory = join(root, "benchmarks", "results");
  const files = (await readdir(directory)).filter(file => file.endsWith(".json")).sort();
  input = files.at(-1) && join(directory, files.at(-1)!);
}
if (!input) throw new Error("No benchmark JSON file found.");
if (outputIndex >= 0 && !output) throw new Error("--output requires a path.");

const report = await Bun.file(resolve(input)).json() as { results?: Result[] };
if (!Array.isArray(report.results) || !report.results.length) {
  throw new Error("Benchmark report has no results.");
}

const groups = new Map<string, number[]>();
for (const result of report.results) {
  const value = result.measurement?.summary?.requestsPerSec;
  if (!Number.isFinite(value)) throw new Error("Benchmark result is missing summary.requestsPerSec.");
  const key = `${result.workload}\0${result.framework}`;
  const values = groups.get(key) ?? [];
  values.push(value!);
  groups.set(key, values);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
};

const lines = [
  "## ORVOX benchmark summary",
  "",
  "| Workload | Framework | Median req/s | Spread |",
  "| --- | --- | ---: | ---: |",
];
for (const [key, values] of [...groups].sort(([left], [right]) => left.localeCompare(right))) {
  const [workload, framework] = key.split("\0");
  const center = median(values);
  const spread = center === 0 ? 0 : ((Math.max(...values) - Math.min(...values)) / center) * 100;
  lines.push(`| ${workload} | ${framework} | ${center.toFixed(2)} | ${spread.toFixed(2)}% |`);
}
const markdown = `${lines.join("\n")}\n`;
if (output) await writeFile(resolve(output), markdown, "utf8");
process.stdout.write(markdown);
