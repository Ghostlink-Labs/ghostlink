import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, PublicKey, SystemProgram, Transaction, type SignatureStatus } from "@solana/web3.js";
import { conservativePolicy, domainHash, fieldToBytes32, intentHash, policyHash } from "@ghostlink/common";
import { BorshWriter, POCKET, pocketPda, writePolicy } from "@ghostlink/service-kit";
import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";
import { SubmissionJournal, type PreparedTransaction } from "../src/journal.js";
import { SubmissionCoordinator, identityFor, type SubmissionChain } from "../src/submission.js";
import type { ValidatedIntent } from "../src/validate.js";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const f of cleanup.reverse()) f(); cleanup.length = 0; });

function world() {
  const dir = mkdtempSync(join(tmpdir(), "ghostlink-submission-test-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const key = randomBytes(32), path = join(dir, "solver.sqlite");
  const solver = Keypair.generate(), session = Keypair.generate();
  const scope = { genesisHash: new PublicKey(randomBytes(32)).toBase58(), solver: solver.publicKey.toBase58(), pocketProgram: POCKET.toBase58() };
  const stores: SubmissionJournal[] = [];
  cleanup.push(() => { for (const s of stores) s.close(); key.fill(0); });
  let now = 1_800_000_000_000;
  const journal = (file = path, encryptionKey = key) => { const j = new SubmissionJournal(file, encryptionKey, scope, () => now); stores.push(j); return j; };
  const policy = conservativePolicy(), pocket = pocketPda(fieldToBytes32(23n));
  const intent = { pocket: pocket.toBytes(), nonce: 7n, inMint: randomBytes(32), inMax: 10n,
    outMint: randomBytes(32), outMin: 9n, deadlineSlot: 900n, policyHash: policyHash(policy) };
  const v: ValidatedIntent = { intent, hash: intentHash(intent), sessionKind: 0, sessionKey: session.publicKey.toBytes(), signature: ed25519.sign(intentHash(intent), session.secretKey.subarray(0, 32)) };
  let currentSession = session, maximumExpiry = 1000n;
  let used = false, expiry = 1000n, head = 100, context = 100, genesis = scope.genesisHash, height = 200, finalizedHeight = 200;
  let status: SignatureStatus | null = null, validHash = true, accountContext = 100;
  let finalizedContext: number | undefined;
  const account = () => {
    const w = new BorshWriter().fixed(createHash("sha256").update("account:PocketV3").digest().subarray(0, 8))
      .fixed(fieldToBytes32(23n)).fixed(fieldToBytes32(domainHash("https://bot.example.com"))).fixed(solver.publicKey.toBytes())
      .u8(0).fixed(Buffer.concat([currentSession.publicKey.toBuffer(), Buffer.alloc(1)])).u64(expiry);
    writePolicy(w, policy); w.u8(0).u64(0n).u64(0n);
    const bitmap = new Uint8Array(256); if (used) bitmap[0] = 128;
    w.fixed(bitmap).u8(PublicKey.findProgramAddressSync([Buffer.from("pocket"), Buffer.from(fieldToBytes32(23n))], POCKET)[1]).u64(maximumExpiry).u64(0n).u64(0n);
    const data = Buffer.alloc(3293); data.set(w.out());
    return { data, owner: POCKET, executable: false, lamports: 1 };
  };
  const chain = {
    getGenesisHash: vi.fn(async () => genesis), getSlot: vi.fn(async (commitment?: string) => commitment === "finalized" ? finalizedContext ?? head : head),
    getAccountInfoAndContext: vi.fn(async (_key?: PublicKey, config?: { commitment?: string }) => ({
      context: { slot: config?.commitment === "finalized" ? finalizedContext ?? accountContext : accountContext }, value: account(),
    })),
    getSignatureStatuses: vi.fn(async () => ({ context: { slot: context }, value: [status] })),
    getBlockHeight: vi.fn(async (config: { commitment?: string }) => config.commitment === "finalized" ? finalizedHeight : height),
    isBlockhashValid: vi.fn(async () => ({ context: { slot: accountContext }, value: validHash })),
    sendRawTransaction: vi.fn(async (raw: Uint8Array) => bs58.encode(Transaction.from(raw).signature!)),
    confirmTransaction: vi.fn(async () => { throw new Error("confirmation timeout"); }),
  };
  const prepare = vi.fn(async (slot = 100): Promise<PreparedTransaction> => {
    const blockhash = new PublicKey(randomBytes(32)).toBase58();
    const tx = new Transaction({ feePayer: solver.publicKey, recentBlockhash: blockhash }).add(
      SystemProgram.transfer({ fromPubkey: solver.publicKey, toPubkey: solver.publicKey, lamports: 0 }));
    tx.sign(solver);
    return { rawBase64: tx.serialize().toString("base64"), signature: bs58.encode(tx.signature!), blockhash,
      lastValidBlockHeight: 500, minContextSlot: slot };
  });
  const manager = (j = journal()) => new SubmissionCoordinator(chain as unknown as SubmissionChain, j, 1000);
  return { dir, path, key, scope, v, prepare, journal, manager, chain,
    rotate: (newExpiry = 1100n, replaceKey: boolean | Keypair = true) => {
      if (replaceKey) currentSession = typeof replaceKey === "boolean" ? Keypair.generate() : replaceKey;
      expiry = maximumExpiry = newExpiry;
      const next = { ...intent, nonce: 8n }, hash = intentHash(next);
      return { ...v, intent: next, hash, sessionKey: currentSession.publicKey.toBytes(),
        signature: ed25519.sign(hash, currentSession.secretKey.subarray(0, 32)) };
    },
    intentAt: (nonce: bigint): ValidatedIntent => {
      const next = { ...intent, nonce }, hash = intentHash(next);
      return { ...v, intent: next, hash, signature: ed25519.sign(hash, session.secretKey.subarray(0, 32)) };
    },
    clock: (n: number) => { now += n; }, useNonce: () => { used = true; }, revoke: () => { expiry = 0n; },
    setStatus: (s: SignatureStatus | null) => { status = s; }, setContext: (s: number) => { context = s; },
    setGenesis: (g: string) => { genesis = g; }, setExpiry: () => { height = finalizedHeight = 501; validHash = false; context = accountContext = head = 700; },
    bank: (h: number, c = h) => { head = h; accountContext = c; }, restoreAuthority: () => { expiry = 1000n; },
    finalizedBank: (slot: number) => { finalizedContext = slot; },
  };
}

describe("durable submission and reconciliation", () => {
  it("rotates storage keys while preserving exact signed transactions and fencing stale workers", async () => {
    const w = world(), original = w.journal(), stale = w.journal(), next = randomBytes(32);
    const identity = identityFor(w.v), claim = original.claim(identity), packet = await w.prepare();
    original.authorizedContext(identity.intentHashHex, 100);
    original.prepared(identity.intentHashHex, claim.token!, packet);
    original.rotateKey(next);
    expect(() => w.journal()).toThrow();
    expect(() => stale.claim(identityFor(w.intentAt(8n)))).toThrow(/key changed/);
    const rotated = w.journal(w.path, next);
    expect(rotated.get(identity.intentHashHex)?.transaction).toEqual(packet);
    const result = await w.manager(rotated).submit(w.v, w.prepare);
    expect(result.signature).toBe(packet.signature);
    expect(w.prepare).toHaveBeenCalledTimes(1);
    expect(Buffer.from(w.chain.sendRawTransaction.mock.calls[0]![0]).toString("base64")).toBe(packet.rawBase64);
    w.useNonce(); w.setStatus({ slot: 100, confirmations: 0, err: null, confirmationStatus: "finalized" });
    expect(await w.manager(rotated).status(identity.intentHashHex)).toMatchObject({ state: "finalized" });
  });

  it("quarantines a restored journal, including unseen pockets, until a finalized fresh owner session", async () => {
    const w = world(), original = w.journal();
    const archive = join(w.dir, "before-trades.enc"); await original.backupTo(archive);
    await w.manager(original).submit(w.v, w.prepare); // Missing from backup, may still land on chain.
    const restoredPath = SubmissionJournal.restoreBackup(archive, join(w.dir, "restored"), w.key, w.scope);
    const restored = w.journal(restoredPath), manager = w.manager(restored);
    await expect(manager.submit(w.v, w.prepare)).rejects.toThrow(/fresh owner session/);
    expect(restored.get(identityFor(w.v).intentHashHex)).toBeUndefined();
    expect(w.prepare).toHaveBeenCalledTimes(1); expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    const newKey = Keypair.generate(), expected = { sessionKind: 0 as const, sessionKeyHex: newKey.publicKey.toBuffer().toString("hex") + "00" };
    expect(await manager.prepareRecovery(identityFor(w.v).pocket, expected)).toMatchObject({ rotationRequired: true });
    // Restart shares the same baseline, and a longer expiry alone is insufficient.
    w.bank(110); w.setContext(110); const reusedKey = w.rotate(1100n, false);
    await expect(w.manager(w.journal(restoredPath)).submit(reusedKey, w.prepare)).rejects.toThrow(/fresh owner session/);
    const notNewer = w.rotate(1000n); await expect(manager.submit(notNewer, w.prepare)).rejects.toThrow(/fresh owner session/);
    const delayedOldRotation = w.rotate(1200n);
    await expect(manager.submit(delayedOldRotation, w.prepare)).rejects.toThrow(/fresh owner session/);
    const fresh = w.rotate(1300n, newKey);
    expect(await manager.prepareRecovery(identityFor(fresh).pocket)).toMatchObject({ rotationRequired: false });
    const newStorageKey = randomBytes(32); restored.rotateKey(newStorageKey);
    const rotatedJournal = w.journal(restoredPath, newStorageKey);
    expect(await w.manager(rotatedJournal).prepareRecovery(identityFor(fresh).pocket)).toMatchObject({ rotationRequired: false });
    // Confirmed head normally leads finalized. Separate monotonic floors must permit this.
    w.bank(140); w.setContext(140); w.finalizedBank(110);
    await manager.submit(fresh, w.prepare);
    expect(w.prepare).toHaveBeenCalledTimes(2); expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(w.chain.getAccountInfoAndContext).toHaveBeenCalledWith(expect.any(PublicKey), { commitment: "finalized", minContextSlot: 110 });
    w.finalizedBank(109);
    await expect(manager.authorize(fresh)).rejects.toThrow(/stale/);
    w.finalizedBank(110);
    await expect(manager.submit(w.v, w.prepare)).rejects.toThrow(/authorized/);
    const again = join(w.dir, "again.enc"); await restored.backupTo(again);
    const twice = w.journal(SubmissionJournal.restoreBackup(again, join(w.dir, "twice"), newStorageKey, w.scope), newStorageKey);
    await expect(w.manager(twice).prepareRecovery(identityFor(fresh).pocket)).rejects.toThrow(/recovery plan/);
  });

  it("retains exact restored transaction identities for reconciliation but refuses rebroadcast without rotation", async () => {
    const w = world(), original = w.journal(); await w.manager(original).submit(w.v, w.prepare);
    const before = original.get(identityFor(w.v).intentHashHex)!;
    const archive = join(w.dir, "pending.enc"); await original.backupTo(archive);
    const restored = w.journal(SubmissionJournal.restoreBackup(archive, join(w.dir, "restored"), w.key, w.scope));
    const manager = w.manager(restored);
    await manager.submit(w.v, w.prepare);
    expect(w.prepare).toHaveBeenCalledTimes(1); expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(restored.get(identityFor(w.v).intentHashHex)?.transaction).toEqual(before.transaction);
    w.setStatus({ slot: 100, confirmations: 0, err: null, confirmationStatus: "confirmed" });
    expect(await manager.status(identityFor(w.v).intentHashHex)).toMatchObject({ state: "confirmed", signature: before.transaction!.signature });
    expect(() => SubmissionJournal.restoreBackup(archive, join(w.dir, "wrong"), w.key,
      { ...w.scope, solver: Keypair.generate().publicKey.toBase58() })).toThrow();
  });

  it("shares refused authorization context across intents without allocating a trade, and migrates prior account floors", async () => {
    const w = world(), first = w.manager(); await first.submit(w.v, w.prepare);
    const other = w.intentAt(8n); w.bank(200); w.revoke();
    await expect(first.submit(other, w.prepare)).rejects.toThrow(/authorized/);
    expect(w.journal().get(identityFor(other).intentHashHex)).toBeUndefined();
    w.bank(100); w.restoreAuthority();
    await w.manager().submit(w.v, w.prepare);
    await expect(w.manager().submit(other, w.prepare)).rejects.toThrow(/stale/);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(w.chain.getAccountInfoAndContext).toHaveBeenLastCalledWith(expect.any(PublicKey), { commitment: "confirmed", minContextSlot: 200 });
    w.journal().authorizedContext(identityFor(w.v).intentHashHex, 200);
    const db = new DatabaseSync(w.path);
    try {
      db.exec("DROP TABLE pocket_contexts"); // Upgrade from records containing only per-intent account floors.
      const upgraded = w.journal(); expect(upgraded.authorizationSlot(identityFor(w.v).pocket)).toBe(200);
      const original = db.prepare("SELECT record FROM pocket_contexts LIMIT 1").get()!.record as Uint8Array;
      const corrupt = Buffer.from(original); corrupt[0]! ^= 1;
      db.prepare("UPDATE pocket_contexts SET record=?").run(corrupt);
      expect(() => upgraded.authorizationSlot(identityFor(w.v).pocket)).toThrow();
    } finally { db.close(); }
  });

  it("never rebroadcasts using account state older than preparation or a later revocation observation, including after restart", async () => {
    const w = world(); await w.manager().submit(w.v, w.prepare);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    w.bank(90);
    await w.manager().submit(w.v, w.prepare);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(w.chain.getAccountInfoAndContext).toHaveBeenLastCalledWith(expect.any(PublicKey), { commitment: "confirmed", minContextSlot: 100 });
    w.bank(150); w.revoke(); await w.manager().submit(w.v, w.prepare);
    w.bank(100); w.restoreAuthority(); await w.manager().submit(w.v, w.prepare);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(w.chain.getAccountInfoAndContext).toHaveBeenLastCalledWith(expect.any(PublicKey), { commitment: "confirmed", minContextSlot: 150 });
    // Processed signature-status context must not masquerade as a confirmed authorization watermark.
    w.setContext(500); w.bank(100, 151); await w.manager().submit(w.v, w.prepare);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(w.chain.sendRawTransaction).toHaveBeenLastCalledWith(expect.any(Buffer), expect.objectContaining({ minContextSlot: 151 }));
    expect(w.prepare).toHaveBeenCalledTimes(1);
  });

  it("recovers signed bytes committed by a process that exits before broadcast", async () => {
    const w = world(), identity = identityFor(w.v), packet = await w.prepare();
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import { readFileSync } from 'node:fs';
      import { SubmissionJournal } from ${JSON.stringify(new URL("../dist/journal.js", import.meta.url).href)};
      const p = JSON.parse(readFileSync(0, 'utf8'));
      const j = new SubmissionJournal(p.path, Buffer.from(p.key, 'hex'), p.scope);
      const claimed = j.claim(p.identity);
      j.prepared(p.identity.intentHashHex, claimed.token, p.packet);
      process.exit(23);
    `], { input: JSON.stringify({ path: w.path, key: w.key.toString("hex"), scope: w.scope, identity, packet }), encoding: "utf8", timeout: 15_000 });
    expect(child.status, child.stderr).toBe(23);
    const j = w.journal(); expect(j.get(identity.intentHashHex)?.transaction).toEqual(packet);
    const replanner = vi.fn(async () => { throw new Error("must not replan a signed trade"); });
    const result = await w.manager(j).submit(w.v, replanner);
    expect(result.signature).toBe(packet.signature); expect(replanner).not.toHaveBeenCalled();
    expect(Buffer.from(w.chain.sendRawTransaction.mock.calls[0]![0]).toString("base64")).toBe(packet.rawBase64);
    for (const name of readdirSync(w.dir)) {
      const file = readFileSync(join(w.dir, name)); expect(file.includes(w.key)).toBe(false);
      expect(file.includes(Buffer.from(packet.rawBase64))).toBe(false);
      expect(file.includes(Buffer.from(packet.rawBase64, "base64"))).toBe(false);
    }
  });

  it("prepares once under concurrent duplicate requests and exposes a recoverable preparing state", async () => {
    const w = world(), first = w.manager(), second = w.manager();
    let release!: () => void;
    const delayed = vi.fn(async (slot: number) => { await new Promise<void>(resolve => { release = resolve; }); return w.prepare(slot); });
    const pending = first.submit(w.v, delayed);
    const deadline = Date.now() + 1000;
    while (!release && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve));
    try {
      expect(release).toBeTypeOf("function");
      expect((await second.submit(w.v, delayed)).state).toBe("preparing");
    } finally { release?.(); }
    const result = await pending; expect(result.signature).toBeDefined(); expect(delayed).toHaveBeenCalledTimes(1);
  });
  it("preserves exact bytes/signature through lost send response, restart and late confirmation without replanning", async () => {
    const w = world(), m = w.manager();
    w.chain.sendRawTransaction.mockRejectedValueOnce(new Error("lost response after acceptance"));
    const first = await m.submit(w.v, w.prepare);
    expect(first.state).toBe("pending"); expect(first.signature).toBeDefined();
    const restarted = w.manager();
    const second = await restarted.submit(w.v, w.prepare);
    expect(second.signature).toBe(first.signature); expect(w.prepare).toHaveBeenCalledTimes(1);
    expect(Buffer.from(w.chain.sendRawTransaction.mock.calls[0]![0])).toEqual(Buffer.from(w.chain.sendRawTransaction.mock.calls[1]![0]));
    w.useNonce(); w.setStatus({ slot: 100, confirmations: 1, err: null, confirmationStatus: "confirmed" });
    const settled = await restarted.submit(w.v, w.prepare);
    expect(settled.state).toBe("confirmed"); expect(settled.signature).toBe(first.signature);
    expect(w.chain.sendRawTransaction).toHaveBeenCalledTimes(2);
    expect(w.chain.getSignatureStatuses).toHaveBeenCalledWith([first.signature], { searchTransactionHistory: true });
    for (const name of readdirSync(w.dir)) expect(readFileSync(join(w.dir, name)).includes(Buffer.from((await w.prepare.mock.results[0]!.value).rawBase64))).toBe(false);
  });

  it("fences a crashed/stalled preparer and refuses conflicting nonce/session or metadata", async () => {
    const w = world(), one = w.journal(), two = w.journal(), identity = identityFor(w.v);
    const old = one.claim(identity); expect(old.token).toBeDefined();
    expect(two.claim(identity).token).toBeUndefined();
    w.clock(30_001); const replacement = two.claim(identity); expect(replacement.token).toBeDefined();
    const packet = await w.prepare();
    expect(() => one.prepared(identity.intentHashHex, old.token!, packet)).toThrow(/lease lost/);
    two.prepared(identity.intentHashHex, replacement.token!, packet);
    expect(() => one.claim({ ...identity, intentHashHex: "ff".repeat(32) })).toThrow(/different intent/);
    expect(() => one.claim({ ...identity, sessionKeyHex: "ff".repeat(32) })).toThrow(/different intent/);
    expect(() => new SubmissionJournal(w.path, randomBytes(32), w.scope)).toThrow();
    expect(() => new SubmissionJournal(w.path, w.key, { ...w.scope, solver: Keypair.generate().publicKey.toBase58() })).toThrow();
  });

  it("authenticates record ciphertext and deployment binding even if the metadata sentinel is removed", async () => {
    const w = world(), j = w.journal(), identity = identityFor(w.v);
    const claim = j.claim(identity); j.prepared(identity.intentHashHex, claim.token!, await w.prepare());
    const db = new DatabaseSync(w.path);
    try {
      const original = db.prepare("SELECT record FROM attempts WHERE id=?").get(identity.intentHashHex)!.record as Uint8Array;
      const corrupt = Buffer.from(original); corrupt[corrupt.length - 1]! ^= 1;
      db.prepare("UPDATE attempts SET record=? WHERE id=?").run(corrupt, identity.intentHashHex);
      expect(() => j.get(identity.intentHashHex)).toThrow();
      db.prepare("UPDATE attempts SET record=? WHERE id=?").run(original, identity.intentHashHex);
      db.exec("DELETE FROM metadata");
      const other = new SubmissionJournal(w.path, w.key, { ...w.scope, genesisHash: Keypair.generate().publicKey.toBase58() });
      try { expect(() => other.get(identity.intentHashHex)).toThrow(); } finally { other.close(); }
    } finally { db.close(); }
  });

  it("never broadcasts when persistence fails or transaction identity is substituted", async () => {
    const w = world(), journal = w.journal(), m = w.manager(journal);
    const save = vi.spyOn(journal, "prepared").mockImplementation(() => { throw new Error("disk full"); });
    await expect(m.submit(w.v, w.prepare)).rejects.toThrow(/disk full/);
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled(); save.mockRestore();
    await expect(m.submit(w.v, async slot => ({ ...await w.prepare(slot), signature: bs58.encode(randomBytes(64)) }))).rejects.toThrow(/identity/);
    expect(w.chain.sendRawTransaction).not.toHaveBeenCalled();
  });

  it("does not create claims for unauthorized, revoked, used-nonce or wrong-network sessions", async () => {
    const w = world(), journal = w.journal(), m = w.manager(journal);
    await expect(m.submit({ ...w.v, sessionKey: randomBytes(32) }, w.prepare)).rejects.toThrow(/authorized/);
    expect(journal.get(identityFor(w.v).intentHashHex)).toBeUndefined();
    w.revoke(); await expect(m.submit(w.v, w.prepare)).rejects.toThrow(/authorized/);
    w.setGenesis(new PublicKey(randomBytes(32)).toBase58());
    await expect(m.submit(w.v, w.prepare)).rejects.toThrow(/genesis/);
    expect(w.prepare).not.toHaveBeenCalled();
    const consumed = world(); consumed.useNonce();
    await expect(consumed.manager().submit(consumed.v, consumed.prepare)).rejects.toThrow(/authorized/);
    expect(consumed.prepare).not.toHaveBeenCalled();
  });

  it("reports confirmation errors, stale RPC and mismatched submission signatures without changing transaction identity", async () => {
    const w = world(), m = w.manager();
    w.chain.sendRawTransaction.mockResolvedValueOnce(bs58.encode(randomBytes(64)));
    const first = await m.submit(w.v, w.prepare);
    expect(first).toMatchObject({ state: "unknown", reason: "rpc_signature_mismatch" });
    w.setContext(99); expect((await m.status(first.intentHashHex)).state).toBe("unknown");
    w.setContext(100); w.setStatus({ slot: 100, confirmations: null, err: { InstructionError: [0, "InvalidArgument"] }, confirmationStatus: "finalized" });
    const failed = await m.status(first.intentHashHex);
    expect(failed).toMatchObject({ state: "failed", signature: first.signature, confirmationStatus: "finalized" });
    expect((await m.submit(w.v, w.prepare)).state).toBe("failed"); expect(w.prepare).toHaveBeenCalledTimes(1);
  });

  it("requires finalized blockhash expiry and an unused nonce; consumed nonce without history stays unknown", async () => {
    const w = world(), m = w.manager(); const first = await m.submit(w.v, w.prepare); w.setExpiry();
    const expired = await m.status(first.intentHashHex);
    expect(expired).toMatchObject({ state: "expired", signature: first.signature });
    await m.submit(w.v, w.prepare); expect(w.prepare).toHaveBeenCalledTimes(1);
    const other = world(), n = other.manager(); const sent = await n.submit(other.v, other.prepare);
    other.useNonce(); other.setExpiry();
    expect(await n.status(sent.intentHashHex)).toMatchObject({ state: "unknown", reason: "nonce_consumed_without_signature_history" });
    expect(other.prepare).toHaveBeenCalledTimes(1);
  });
});
