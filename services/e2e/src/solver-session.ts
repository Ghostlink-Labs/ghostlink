/** Durable solver fixture: intentionally lose the first broadcast acknowledgment. */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { AddressLookupTableProgram, PublicKey, Transaction, VersionedTransaction, type Connection, type Keypair } from "@solana/web3.js";
import { POCKET_PROGRAM_ID } from "@ghostlink/common";
import { SubmissionJournal } from "@ghostlink/solver/journal";
import { buildServer, MockPlanner, type RoutePlanner } from "@ghostlink/solver/server";
import { ataAddress } from "@ghostlink/service-kit";

export async function startSolverFixture(connection: Connection, keypair: Keypair, priceAccounts: Record<string, string>, port = 0,
  options: { planner?: RoutePlanner; lookupAddresses?: PublicKey[] } = {}) {
  // A real table exercises RPC ownership/mapping checks and v0 lookup resolution in the fill.
  const addresses = [...Object.keys(priceAccounts).map(m => new PublicKey(m)),
    ...Object.values(priceAccounts).map(a => new PublicKey(a)),
    ...Object.keys(priceAccounts).map(m => ataAddress(keypair.publicKey, new PublicKey(m))), ...(options.lookupAddresses ?? [])];
  const [createTable, table] = AddressLookupTableProgram.createLookupTable({ authority: keypair.publicKey,
    payer: keypair.publicKey, recentSlot: await connection.getSlot("finalized") });
  const lifetime = await connection.getLatestBlockhash("confirmed");
  const setup = new Transaction({ feePayer: keypair.publicKey, ...lifetime }).add(createTable,
    AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: keypair.publicKey, payer: keypair.publicKey, addresses }));
  setup.sign(keypair);
  const setupSignature = await connection.sendRawTransaction(setup.serialize());
  const setupResult = await connection.confirmTransaction({ signature: setupSignature, ...lifetime }, "finalized");
  if (setupResult.value.err) throw new Error("lookup-table fixture setup failed");
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-solver-e2e-"));
  const path = join(dir, "solver.sqlite"), key = randomBytes(32);
  const scope = { genesisHash: await connection.getGenesisHash(), pocketProgram: POCKET_PROGRAM_ID, solver: keypair.publicKey.toBase58() };
  let journal = new SubmissionJournal(path, key, scope);
  let first = true, plans = 0, simulations = 0, feeChecks = 0;
  let broadcastFailure: unknown;
  let beforeNextBroadcast: (() => Promise<void>) | undefined;
  const packets = new Set<string>();
  const transport = new Proxy(connection, {
    get(target, property) {
      if (property === "sendRawTransaction") return async (...args: Parameters<Connection["sendRawTransaction"]>) => {
        let signature: string;
        try {
          const decoded = VersionedTransaction.deserialize(Buffer.from(args[0]));
          if (decoded.version !== 0 || decoded.message.addressTableLookups.length !== 1) throw new Error("fill did not use the verified lookup table");
          packets.add(Buffer.from(args[0]).toString("base64"));
          const intervene = beforeNextBroadcast;
          beforeNextBroadcast = undefined;
          if (intervene) {
            // Negative local-fork test: change the market after both complete simulations, then
            // deliberately submit the now-failing packet to verify actual on-chain rollback.
            await intervene();
            signature = await target.sendRawTransaction(args[0], { ...args[1], skipPreflight: true });
          } else signature = await target.sendRawTransaction(...args);
        } catch (error) { broadcastFailure = error; throw error; }
        if (first) { first = false; throw new Error("synthetic lost broadcast acknowledgment"); }
        return signature;
      };
      if (property === "simulateTransaction") return async (...args: Parameters<Connection["simulateTransaction"]>) => {
        simulations += 1; return target.simulateTransaction(...args);
      };
      if (property === "getFeeForMessage") return async (...args: Parameters<Connection["getFeeForMessage"]>) => {
        feeChecks += 1; return target.getFeeForMessage(...args);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const route = options.planner ?? new MockPlanner();
  const planner = { plan: async (...args: Parameters<RoutePlanner["plan"]>) => {
    plans += 1; return { ...await route.plan(...args), lookupTables: [{ address: table, addresses }] };
  } };
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
    async restart() {
      if (first) throw new Error("fixture never reached the lost-acknowledgment boundary", { cause: broadcastFailure });
      await stop(); journal.close(); journal = new SubmissionJournal(path, key, scope); server = build(); return listen();
    },
    assertSingleTransaction(count = 1) {
      if (plans !== count || packets.size !== count || simulations !== 2 * count || feeChecks !== count) {
        throw new Error(`unexpected preparation/retry: ${plans} plans, ${packets.size} packets, ${simulations} simulations, ${feeChecks} fee checks`);
      }
    },
    beforeNextBroadcast(work: () => Promise<void>) { beforeNextBroadcast = work; },
    async close() { await stop(); journal.close(); key.fill(0); rmSync(dir, { recursive: true, force: true }); },
  };
}
