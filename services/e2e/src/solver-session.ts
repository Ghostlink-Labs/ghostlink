/** Durable solver fixture: intentionally lose the first broadcast acknowledgment. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { Connection, Keypair } from "@solana/web3.js";
import { POCKET_PROGRAM_ID } from "@ghostlink/common";
import { SubmissionJournal } from "@ghostlink/solver/journal";
import { buildServer, MockPlanner } from "@ghostlink/solver/server";

export async function startSolverFixture(connection: Connection, keypair: Keypair, priceAccounts: Record<string, string>, port = 0) {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-solver-e2e-"));
  const path = join(dir, "solver.sqlite"), key = randomBytes(32);
  const scope = { genesisHash: await connection.getGenesisHash(), pocketProgram: POCKET_PROGRAM_ID, solver: keypair.publicKey.toBase58() };
  let journal = new SubmissionJournal(path, key, scope);
  let first = true, plans = 0;
  const packets = new Set<string>();
  const transport = new Proxy(connection, {
    get(target, property) {
      if (property === "sendRawTransaction") return async (...args: Parameters<Connection["sendRawTransaction"]>) => {
        packets.add(Buffer.from(args[0]).toString("base64"));
        const signature = await target.sendRawTransaction(...args);
        if (first) { first = false; throw new Error("synthetic lost broadcast acknowledgment"); }
        return signature;
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const inventory = new MockPlanner();
  const planner = { plan: async (...args: Parameters<MockPlanner["plan"]>) => { plans += 1; return inventory.plan(...args); } };
  const build = () => buildServer({ connection: transport, keypair, priceAccounts, planner, journal });
  let server = build(), url = "";
  const listen = async () => {
    server.listen(port, "127.0.0.1"); await once(server, "listening");
    const addr = server.address(); if (!addr || typeof addr === "string") throw new Error("no solver address");
    url = `http://127.0.0.1:${addr.port}`; return url;
  };
  const stop = () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await listen();
  return { get url() { return url; },
    async restart() { await stop(); journal.close(); journal = new SubmissionJournal(path, key, scope); server = build(); return listen(); },
    assertSingleTransaction() { if (plans !== 1 || packets.size !== 1) throw new Error(`retry rebuilt a trade: ${plans} plans, ${packets.size} distinct packets`); },
    async close() { await stop(); journal.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); },
  };
}
