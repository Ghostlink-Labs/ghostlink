import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
it.skipIf(process.platform === "win32")("drains a real hosted process and resumes its atomic checkpoint", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./drain-drill.mjs", import.meta.url))], { encoding: "utf8", timeout: 25_000 });
  expect(output).toContain("Indexer drain drill passed");
}, 30_000);
