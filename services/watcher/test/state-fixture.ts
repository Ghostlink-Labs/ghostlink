import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, Connection } from "@solana/web3.js";
import { POCKET, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { vi } from "vitest";
import { WatcherState, type WatchScope } from "../src/state.js";
import { Watcher, type WatcherOptions, type Notifier } from "../src/index.js";
export const info = (signature: string, slot = 1, err: unknown = null) => ({ signature, slot, err, memo: null, blockTime: 0 });
export const pocket = Keypair.generate().publicKey;
const after = Buffer.alloc(8); after.writeBigUInt64LE(100n);
export const proposalLogs = frameAsProgramLogs(POCKET.toBase58(), ["Program data: " + Buffer.concat([eventDisc("ChangeProposed"), pocket.toBytes(), after]).toString("base64")]);
export function stateWorld() {
  const directory = mkdtempSync(join(tmpdir(), "watcher-state-")), path = join(directory, "state.sqlite"), key = randomBytes(32);
  const scope: WatchScope = { genesisHash: Keypair.generate().publicKey.toBase58(), pocketProgram: POCKET.toBase58(), payer: null, receiver: "fixture", threshold: "1" };
  const states: WatcherState[] = []; let now = Date.now();
  const open = (s = scope, target = path, maximum = 1_000_000) => { const db = new WatcherState(target, key, s, () => now, maximum); states.push(db); return db; };
  const chain = { getSlot: vi.fn(async () => 1), getSignaturesForAddress: vi.fn(async (_p?: any, _config?: any) => [info("A")]),
    getTransaction: vi.fn(async (signature: string): Promise<any> => ({ slot: 1, transaction: { signatures: [signature] }, meta: { err: null, logMessages: proposalLogs } })) };
  return { directory, path, key, scope, open, chain, advance: (ms: number) => { now += ms; },
    watcher: (db = open(), notifier: Notifier = { notify: async () => {} }, options: WatcherOptions = {}) => new Watcher(chain as unknown as Connection, notifier, 1n, undefined, db, undefined, options),
    cleanup: () => { for (const db of states) db.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); } };
}
