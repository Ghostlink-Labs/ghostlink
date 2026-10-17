import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  type AccountInfo,
} from "@solana/web3.js";
import { conservativePolicy } from "@ghostlink/common";
import {
  BorshWriter,
  POCKET,
  POCKET_ACCOUNT_SIZE,
  TOKEN,
  ataAddress,
  computeBudget,
  pocketPda,
  sweepHomeIx,
  writePolicy,
} from "@ghostlink/service-kit";
import { prepareRecoverySweep } from "../src/recovery.js";

function world() {
  const payer = Keypair.generate(),
    home = Keypair.generate().publicKey,
    mint = Keypair.generate().publicKey,
    source = Keypair.generate().publicKey,
    id = new Uint8Array(32).fill(3),
    pocket = pocketPda(id);
  const writer = new BorshWriter()
    .fixed(
      createHash("sha256").update("account:PocketV3").digest().subarray(0, 8),
    )
    .fixed(id)
    .fixed(new Uint8Array(32))
    .fixed(home.toBytes())
    .u8(0)
    .fixed(new Uint8Array(33))
    .u64(0n);
  writePolicy(writer, conservativePolicy());
  writer
    .u8(0)
    .u64(0n)
    .u64(0n)
    .fixed(new Uint8Array(256))
    .u8(255)
    .u64(0n)
    .u64(0n)
    .u64(0n);
  const data = Buffer.alloc(POCKET_ACCOUNT_SIZE);
  data.set(writer.out());
  const info = (data: Buffer, owner = TOKEN): AccountInfo<Buffer> => ({
    data,
    owner,
    executable: false,
    lamports: 2039280,
    rentEpoch: 0,
  });
  const token = (owner: PublicKey, m = mint) => {
    const d = Buffer.alloc(165);
    m.toBuffer().copy(d);
    owner.toBuffer().copy(d, 32);
    d.writeBigUInt64LE(123n, 64);
    d[108] = 1;
    return info(d);
  };
  const accounts = new Map<string, AccountInfo<Buffer>>([
    [pocket.toBase58(), info(data, POCKET)],
    [source.toBase58(), token(pocket)],
  ]);
  const rpc = {
    getSlot: vi.fn(async () => 100),
    getAccountInfoAndContext: vi.fn(async (address: PublicKey) => ({
      context: { slot: 101 },
      value: accounts.get(address.toBase58()) ?? null,
    })),
    getMultipleAccountsInfoAndContext: vi.fn(
      async (addresses: PublicKey[]) => ({
        context: { slot: 102 },
        value: addresses.map((a) => accounts.get(a.toBase58()) ?? null),
      }),
    ),
    getMinimumBalanceForRentExemption: vi.fn(async () => 2039280),
  };
  const prepare = (
    pairs: Parameters<typeof prepareRecoverySweep>[4],
    h = home,
  ) =>
    prepareRecoverySweep(
      rpc as unknown as Connection,
      payer.publicKey,
      pocket,
      h,
      pairs,
    );
  return { payer, home, mint, source, pocket, accounts, rpc, token, prepare };
}
it("reuses a clean home account, creates a missing ATA once and does not substitute an explicit destination", async () => {
  const w = world(),
    destination = ataAddress(w.home, w.mint),
    other = Keypair.generate().publicKey;
  w.accounts.set(other.toBase58(), w.token(w.pocket));
  let plan = await w.prepare([
    { source: w.source },
    { source: other, mint: w.mint },
  ]);
  expect(plan.rent).toBe(2039280n);
  expect(plan.instructions).toHaveLength(1);
  expect(plan.signers).toHaveLength(0);
  expect(plan.pairs.every((p) => p.destination.equals(destination))).toBe(true);
  w.accounts.set(destination.toBase58(), w.token(w.home));
  plan = await w.prepare([{ source: w.source, destination }]);
  expect(plan.instructions).toHaveLength(0);
  expect(plan.rent).toBe(0n);
  w.accounts.set(destination.toBase58(), w.token(w.pocket));
  await expect(w.prepare([{ source: w.source, destination }])).rejects.toThrow(
    /omit destination/,
  );
});
it("atomically initializes two fresh exclusively home-owned destinations within the transaction limit", async () => {
  const w = world(),
    secondMint = Keypair.generate().publicKey,
    secondSource = Keypair.generate().publicKey;
  w.accounts.set(secondSource.toBase58(), w.token(w.pocket, secondMint));
  w.accounts.set(ataAddress(w.home, w.mint).toBase58(), w.token(w.pocket));
  const delegated = w.token(w.home, secondMint);
  delegated.data.writeUInt32LE(1, 72);
  Keypair.generate().publicKey.toBuffer().copy(delegated.data, 76);
  delegated.data.writeBigUInt64LE(999n, 121);
  w.accounts.set(ataAddress(w.home, secondMint).toBase58(), delegated);
  const plan = await w.prepare([
    { source: w.source, mint: w.mint },
    { source: secondSource, mint: secondMint },
  ]);
  expect(plan.rent).toBe(4078560n);
  expect(plan.signers).toHaveLength(2);
  expect(plan.instructions).toHaveLength(4);
  for (const ix of [plan.instructions[1]!, plan.instructions[3]!]) {
    expect(ix.programId.equals(TOKEN)).toBe(true);
    expect(ix.data[0]).toBe(18);
    expect(ix.data.subarray(1).equals(w.home.toBuffer())).toBe(true);
  }
  const tx = new Transaction().add(
    computeBudget(400000),
    ...plan.instructions,
    sweepHomeIx({
      payer: w.payer.publicKey,
      pocket: w.pocket,
      home: w.home,
      auth: {
        proofA: new Uint8Array(64),
        proofB: new Uint8Array(128),
        proofC: new Uint8Array(64),
        registryRoot: new Uint8Array(32),
      },
      tokenPairs: plan.pairs,
    }),
  );
  tx.feePayer = w.payer.publicKey;
  tx.recentBlockhash = SystemProgram.programId.toBase58();
  tx.sign(w.payer, ...plan.signers);
  expect(tx.serialize().length).toBeLessThanOrEqual(1232);
  expect(tx.verifySignatures()).toBe(true);
});
it("refuses wrong home, source, mint, duplicate accounts and stale RPC before paying for recovery", async () => {
  const w = world();
  await expect(
    w.prepare([{ source: w.source }], Keypair.generate().publicKey),
  ).rejects.toThrow(/home mismatch/);
  await expect(
    w.prepare([{ source: w.source }, { source: w.source }]),
  ).rejects.toThrow(/sources/);
  await expect(
    w.prepare([{ source: w.source, mint: Keypair.generate().publicKey }]),
  ).rejects.toThrow(/source or mint/);
  w.rpc.getMultipleAccountsInfoAndContext.mockResolvedValueOnce({
    context: { slot: 99 },
    value: [w.token(w.pocket)],
  });
  await expect(w.prepare([{ source: w.source }])).rejects.toThrow(/stale/);
  w.accounts.set(w.source.toBase58(), w.token(w.home));
  await expect(w.prepare([{ source: w.source }])).rejects.toThrow(
    /source or mint/,
  );
  expect(w.rpc.getMinimumBalanceForRentExemption).not.toHaveBeenCalled();
});
it("uses one auxiliary account per mint and avoids frozen or foreign-close destinations", async () => {
  for (const kind of ["frozen", "close", "invalid"]) {
    const w = world(),
      other = Keypair.generate().publicKey,
      canonical = ataAddress(w.home, w.mint),
      bad = w.token(w.home);
    if (kind === "frozen") bad.data[108] = 2;
    if (kind === "close") {
      bad.data.writeUInt32LE(1, 129);
      Keypair.generate().publicKey.toBuffer().copy(bad.data, 133);
    }
    if (kind === "invalid") bad.owner = SystemProgram.programId;
    w.accounts.set(canonical.toBase58(), bad);
    w.accounts.set(other.toBase58(), w.token(w.pocket));
    const plan = await w.prepare([{ source: w.source }, { source: other }]);
    expect(plan.signers).toHaveLength(1);
    expect(plan.rent).toBe(2039280n);
    expect(plan.pairs[0]!.destination.equals(canonical)).toBe(false);
    expect(plan.pairs[0]!.destination.equals(plan.pairs[1]!.destination)).toBe(
      true,
    );
  }
});
