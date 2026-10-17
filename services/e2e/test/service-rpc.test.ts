import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("runs service entry points against failing credential-bearing RPC providers", () => {
  const output = execFileSync(process.execPath, [fileURLToPath(new URL("./service-rpc-drill.mjs", import.meta.url))],
    { encoding: "utf8", timeout: 40_000 });
  expect(output).toContain("Service RPC drill passed");
}, 45_000);
