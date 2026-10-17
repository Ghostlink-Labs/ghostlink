import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, type SignatureStatus } from "@solana/web3.js";
import { conservativePolicy } from "@ghostlink/common";
import { BorshWriter, POCKET, pocketPda, POCKET_ACCOUNT_SIZE, writePolicy, eventDisc, frameAsProgramLogs } from "@ghostlink/service-kit";
import { vi } from "vitest";
import bs58 from "bs58";
import { CrankJournal } from "../src/journal.js";
import { WatcherState } from "../src/state.js";
import { Watcher } from "../src/index.js";
import { DurableCranker } from "../src/crank.js";

export function world(totalBudgetLamports = 20_000) {
  const directory = mkdtempSync(join(tmpdir(), "ghostlink-crank-test-")), path = join(directory, "crank.sqlite"), state = join(directory, "state.sqlite");
  const key = randomBytes(32), payer = Keypair.generate(), genesis = Keypair.generate().publicKey.toBase58(), appId = randomBytes(32);
  const pocket = pocketPda(appId), home = Keypair.generate().publicKey, newHome = Keypair.generate().publicKey;
  let pending = true, after = 100n, slot = 101, height = 150, valid = true, status: SignatureStatus | null = null;
  const scope = { genesisHash: genesis, pocketProgram: POCKET.toBase58(), payer: payer.publicKey.toBase58() };
  const stores: CrankJournal[] = [];
  const states: WatcherState[] = [];
  const open = () => { const j = new CrankJournal(path, key, scope, { maximumFeeLamports: 10_000, totalBudgetLamports }); stores.push(j); return j; };
  const account = () => {
    const w = new BorshWriter().fixed(createHash("sha256").update("account:PocketV3").digest().subarray(0, 8))
      .fixed(appId).fixed(randomBytes(32)).fixed(home.toBytes()).u8(0).fixed(new Uint8Array(33)).u64(0n);
    writePolicy(w, conservativePolicy());
    w.u8(pending ? 1 : 0); if (pending) w.u8(0).fixed(newHome.toBytes()).u64(after);
    w.u64(0n).u64(0n).fixed(new Uint8Array(256)).u8(PublicKey.findProgramAddressSync([Buffer.from("pocket"), appId], POCKET)[1])
      .u64(0n).u64(0n).u64(0n);
    const data = Buffer.alloc(POCKET_ACCOUNT_SIZE); data.set(w.out());
    return { data, owner: POCKET, executable: false, lamports: 100_000_000 };
  };
  const afterBytes = Buffer.alloc(8); afterBytes.writeBigUInt64LE(after);
  const logs = frameAsProgramLogs(POCKET.toBase58(), ["Program data: " + Buffer.concat([eventDisc("ChangeProposed"), pocket.toBuffer(), afterBytes]).toString("base64")]);
  const chain = {
    getGenesisHash: vi.fn(async () => genesis), getSlot: vi.fn(async () => slot),
    getAccountInfoAndContext: vi.fn(async () => ({ context: { slot }, value: account() })),
    getLatestBlockhashAndContext: vi.fn(async () => ({ context: { slot }, value: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: height + 50 } })),
    getFeeForMessage: vi.fn(async () => ({ context: { slot }, value: 5000 as number | null })),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot }, value: [status] })),
    getBlockHeight: vi.fn(async () => height), isBlockhashValid: vi.fn(async () => ({ context: { slot }, value: valid })),
    sendRawTransaction: vi.fn(async (bytes: Uint8Array) => bs58.encode(Transaction.from(bytes).signature!)),
    confirmTransaction: vi.fn(async () => { status = { slot, confirmations: 1, err: null, confirmationStatus: "confirmed" }; return { value: { err: null }, context: { slot } }; }),
    getSignaturesForAddress: vi.fn(async () => [{ signature: "proposal", slot: 1, err: null, memo: null, blockTime: 0 }]),
    getTransaction: vi.fn(async () => ({ slot: 1, transaction: { signatures: ["proposal"] }, meta: { err: null, logMessages: logs } })),
  };
  return { directory, path, state, key, payer, genesis, pocket, scope, open, chain,
    cranker: (j = open()) => new DurableCranker(chain as unknown as Connection, payer, j),
    watcher: (j = open()) => {
      const db = new WatcherState(state, key, { genesisHash: genesis, pocketProgram: POCKET.toBase58(), payer: payer.publicKey.toBase58(), receiver: "fixture", threshold: "1" });
      states.push(db); return new Watcher(chain as unknown as Connection, { notify: async () => {} }, 1n, payer, db, j);
    },
    status: (s: SignatureStatus | null) => { status = s; }, pending: (v: boolean) => { pending = v; },
    after: (n: bigint) => { after = n; }, slot: (n: number) => { slot = n; },
    expire: () => { height = 300; slot = 400; valid = false; status = null; },
    cleanup: () => { for (const db of states) db.close(); for (const store of stores) store.close(); key.fill(0); rmSync(directory, { recursive: true, force: true }); },
  };
}
