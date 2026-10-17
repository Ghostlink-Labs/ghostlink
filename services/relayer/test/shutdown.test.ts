import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")("drains a real relayer after SIGTERM and client disconnect", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./shutdown-drill.mjs", import.meta.url))],
    { encoding: "utf8", timeout: 30_000 });
  expect(output).toContain("Relayer SIGTERM drill passed");
}, 35_000);
