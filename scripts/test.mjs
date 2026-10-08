import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
function find(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? find(join(dir, e.name))
      : e.name.endsWith(".test.ts")
        ? [join(dir, e.name)]
        : [],
  );
}
const tests = ["tests", "packages", "apps"].flatMap(find);
const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", ...tests],
  { stdio: "inherit" },
);
process.exit(result.status ?? 1);
