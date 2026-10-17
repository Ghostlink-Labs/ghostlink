/**
 * Instruction builders for the three programs. Account orders and borsh
 * layouts mirror programs/* exactly; the Rust integration tests prove
 * those shapes on-chain, and this file is their TypeScript twin.
 */
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import {
  CENSUS_PROGRAM_ID,
  POCKET_PROGRAM_ID,
  REGISTRY_PROGRAM_ID,
  SPL_TOKEN_PROGRAM_ID,
  policyBytes,
  type Policy,
} from "@ghostlink/common";
import { BorshWriter } from "./borsh.js";

export const REGISTRY = new PublicKey(REGISTRY_PROGRAM_ID);
export const CENSUS = new PublicKey(CENSUS_PROGRAM_ID);
export const POCKET = new PublicKey(POCKET_PROGRAM_ID);
export const TOKEN = new PublicKey(SPL_TOKEN_PROGRAM_ID);

export function disc(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).subarray(0, 8);
}

function data(name: string, body?: Uint8Array): Buffer {
  const d = disc(name);
  const out = Buffer.alloc(8 + (body?.length ?? 0));
  out.set(d, 0);
  if (body) out.set(body, 8);
  return out;
}

export function registryTreePda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("tree")], REGISTRY)[0];
}

export function censusTreePda(): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("census")], CENSUS)[0];
}

export function bindingPda(wallet: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("binding"), wallet.toBuffer()], REGISTRY)[0];
}

export function pocketPda(appId: Uint8Array): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("pocket"), Buffer.from(appId)], POCKET)[0];
}

export function fillStatePda(pocket: PublicKey, nonce: bigint): PublicKey {
  const n = Buffer.alloc(8);
  n.writeBigUInt64LE(nonce);
  return PublicKey.findProgramAddressSync([Buffer.from("fill"), pocket.toBuffer(), n], POCKET)[0];
}

export const computeBudget = (units: number) =>
  ComputeBudgetProgram.setComputeUnitLimit({ units });

export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

/** Associated token account address for (owner, mint). */
export function ataAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN.toBuffer(), mint.toBuffer()],
    ATA_PROGRAM,
  )[0];
}

/** ATA CreateIdempotent (instruction 1): a no-op when it already exists. */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** SPL InitializeMint2 (instruction 20). */
export function initializeMint2Ix(mint: PublicKey, decimals: number, authority: PublicKey) {
  const data = Buffer.alloc(1 + 1 + 32 + 1);
  data[0] = 20;
  data[1] = decimals;
  authority.toBuffer().copy(data, 2);
  data[34] = 0; // no freeze authority
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data,
  });
}

/** SPL MintTo (instruction 7). */
export function mintToIx(mint: PublicKey, destination: PublicKey, authority: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9);
  data[0] = 7;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** SPL Token Transfer (instruction 3) with a normal signing authority. */
export function splTransferIx(
  source: PublicKey,
  destination: PublicKey,
  authority: PublicKey,
  amount: bigint,
) {
  const data = Buffer.alloc(9);
  data[0] = 3;
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

// ---- registry / census ---------------------------------------------------

export function registerIx(payer: PublicKey, wallet: PublicKey, commitment: Uint8Array) {
  return new TransactionInstruction({
    programId: REGISTRY,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: bindingPda(wallet), isSigner: false, isWritable: true },
      { pubkey: registryTreePda(), isSigner: false, isWritable: true },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data("register", new BorshWriter().fixed(commitment, 32).out()),
  });
}

export function snapshotIx(payer: PublicKey, wallet: PublicKey, holding: PublicKey) {
  return new TransactionInstruction({
    programId: CENSUS,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: wallet, isSigner: false, isWritable: false },
      { pubkey: holding, isSigner: false, isWritable: false },
      { pubkey: censusTreePda(), isSigner: false, isWritable: true },
    ],
    data: data("snapshot"),
  });
}

export function initializeIx(program: "registry" | "census", payer: PublicKey) {
  const [programId, tree] =
    program === "registry" ? [REGISTRY, registryTreePda()] : [CENSUS, censusTreePda()];
  return new TransactionInstruction({
    programId,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: tree, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data("initialize"),
  });
}

// ---- pocket ---------------------------------------------------------------

export interface OpenSessionFields {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  registryRoot: Uint8Array;
  censusRoot: Uint8Array;
  domainHash: Uint8Array;
  appId: Uint8Array;
  mint: PublicKey;
  threshold: bigint;
  minSlot: bigint;
  claimHoldings: boolean;
  sessionKind: number;
  sessionKey: Uint8Array; // 33
  sessionExpirySlot: bigint;
  home: PublicKey;
  policy?: Policy;
}

export function writePolicy(w: BorshWriter, p: Policy): void {
  policyBytes(p); // Share canonical validation before accepting a paid transaction.
  w.u64(p.dailyCapUsdE6)
    .u16(p.maxSlippageBps)
    .u64(p.bigActionThresholdUsdE6)
    .u64(p.noOracleCapUsdE6)
    .u64(p.sessionMaxSlots)
    .vec(p.allowedOutMints, (ww, m) => ww.fixed(m, 32))
    .vec(p.oracleFeeds, (ww, f) => {
      ww.fixed(f.mint, 32).fixed(f.feedId, 32).u8(f.decimals);
    })
    .option(p.speculative, (ww, s) => ww.u64(s.dailyBuyCapUsdE6).u64(s.maxCostExposureUsdE6)
      .u8(s.maxPositions).vec(s.baseMints, (writer, m) => writer.fixed(m, 32)));
}

export function openSessionIx(payer: PublicKey, f: OpenSessionFields) {
  const w = new BorshWriter()
    .fixed(f.proofA, 64)
    .fixed(f.proofB, 128)
    .fixed(f.proofC, 64)
    .fixed(f.registryRoot, 32)
    .fixed(f.censusRoot, 32)
    .fixed(f.domainHash, 32)
    .fixed(f.appId, 32)
    .fixed(f.mint.toBytes(), 32)
    .u64(f.threshold)
    .u64(f.minSlot)
    .bool(f.claimHoldings)
    .u8(f.sessionKind)
    .fixed(f.sessionKey, 33)
    .u64(f.sessionExpirySlot)
    .fixed(f.home.toBytes(), 32)
    .option(f.policy, (ww, p) => writePolicy(ww, p));
  return new TransactionInstruction({
    programId: POCKET,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: pocketPda(f.appId), isSigner: false, isWritable: true },
      { pubkey: registryTreePda(), isSigner: false, isWritable: false },
      { pubkey: censusTreePda(), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data("open_session_v2", w.out()),
  });
}

export interface IntentFields {
  nonce: bigint;
  inMint: PublicKey;
  inMax: bigint;
  outMint: PublicKey;
  outMin: bigint;
  deadlineSlot: bigint;
  policyHash: Uint8Array;
}

export function writeIntentArgs(w: BorshWriter, f: IntentFields): void {
  w.u64(f.nonce)
    .fixed(f.inMint.toBytes(), 32)
    .u64(f.inMax)
    .fixed(f.outMint.toBytes(), 32)
    .u64(f.outMin)
    .u64(f.deadlineSlot)
    .fixed(f.policyHash, 32);
}

export interface WebauthnFields {
  authenticatorData: Uint8Array;
  clientDataJson: Uint8Array;
}

const writeWebauthn = (w: BorshWriter, wa: WebauthnFields) => {
  w.bytes(wa.authenticatorData).bytes(wa.clientDataJson);
};

export function fillBeginIx(params: {
  solver: PublicKey;
  pocket: PublicKey;
  pocketIn: PublicKey;
  solverIn: PublicKey;
  pocketOut: PublicKey;
  inPrice: PublicKey;
  intent: IntentFields;
  webauthn?: WebauthnFields;
}) {
  const w = new BorshWriter();
  writeIntentArgs(w, params.intent);
  w.option(params.webauthn, writeWebauthn);
  return new TransactionInstruction({
    programId: POCKET,
    keys: [
      { pubkey: params.solver, isSigner: true, isWritable: true },
      { pubkey: params.pocket, isSigner: false, isWritable: true },
      { pubkey: params.pocketIn, isSigner: false, isWritable: true },
      { pubkey: params.solverIn, isSigner: false, isWritable: true },
      { pubkey: params.pocketOut, isSigner: false, isWritable: false },
      { pubkey: params.inPrice, isSigner: false, isWritable: false },
      { pubkey: fillStatePda(params.pocket, params.intent.nonce), isSigner: false, isWritable: true },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: data("fill_begin", w.out()),
  });
}

export function fillEndIx(params: {
  solver: PublicKey;
  pocket: PublicKey;
  pocketOut: PublicKey;
  outPrice?: PublicKey;
  intent: IntentFields;
}) {
  const w = new BorshWriter();
  writeIntentArgs(w, params.intent);
  return new TransactionInstruction({
    programId: POCKET,
    keys: [
      { pubkey: params.solver, isSigner: true, isWritable: true },
      { pubkey: params.pocket, isSigner: false, isWritable: true },
      { pubkey: fillStatePda(params.pocket, params.intent.nonce), isSigner: false, isWritable: true },
      { pubkey: params.pocketOut, isSigner: false, isWritable: false },
      // Anchor optional account: the program id itself means None.
      { pubkey: params.outPrice ?? POCKET, isSigner: false, isWritable: false },
    ],
    data: data("fill_end", w.out()),
  });
}

export interface OwnerProofFields {
  proofA: Uint8Array;
  proofB: Uint8Array;
  proofC: Uint8Array;
  registryRoot: Uint8Array;
}

const writeOwnerProof = (w: BorshWriter, p: OwnerProofFields) => {
  w.fixed(p.proofA, 64).fixed(p.proofB, 128).fixed(p.proofC, 64).fixed(p.registryRoot, 32);
};

/** SessionOrOwner enum: 0 = Session { webauthn }, 1 = Owner(proof). */
function writeAuth(w: BorshWriter, auth: { webauthn?: WebauthnFields } | OwnerProofFields): void {
  if ("proofA" in auth) {
    w.u8(1);
    writeOwnerProof(w, auth);
  } else {
    w.u8(0).option(auth.webauthn, writeWebauthn);
  }
}

export function sweepHomeIx(params: {
  payer: PublicKey;
  pocket: PublicKey;
  home: PublicKey;
  auth: { webauthn?: WebauthnFields } | OwnerProofFields;
  tokenPairs: { source: PublicKey; destination: PublicKey }[];
}) {
  const w = new BorshWriter();
  writeAuth(w, params.auth);
  return new TransactionInstruction({
    programId: POCKET,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.pocket, isSigner: false, isWritable: true },
      { pubkey: params.home, isSigner: false, isWritable: true },
      { pubkey: registryTreePda(), isSigner: false, isWritable: false },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      ...params.tokenPairs.flatMap((p) => [
        { pubkey: p.source, isSigner: false, isWritable: true },
        { pubkey: p.destination, isSigner: false, isWritable: true },
      ]),
    ],
    data: data("sweep_home", w.out()),
  });
}

export function revokeSessionIx(params: {
  payer: PublicKey;
  pocket: PublicKey;
  auth: { webauthn?: WebauthnFields } | OwnerProofFields;
}) {
  const w = new BorshWriter();
  writeAuth(w, params.auth);
  return new TransactionInstruction({
    programId: POCKET,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.pocket, isSigner: false, isWritable: true },
      { pubkey: registryTreePda(), isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: data("revoke_session", w.out()),
  });
}

/** Change enum: 0 = Home(pubkey), 1 = Policy(policy). */
export type ChangeFields = { home: PublicKey } | { policy: Policy };

export function writeChange(w: BorshWriter, c: ChangeFields): void {
  if ("home" in c) {
    w.u8(0).fixed(c.home.toBytes(), 32);
  } else {
    w.u8(1);
    writePolicy(w, c.policy);
  }
}

export function proposeChangeIx(params: {
  payer: PublicKey;
  pocket: PublicKey;
  change: ChangeFields;
  proof: OwnerProofFields;
}) {
  const w = new BorshWriter();
  writeChange(w, params.change);
  writeOwnerProof(w, params.proof);
  return ownerActionIx("propose_change", params.payer, params.pocket, w.out());
}

export function cancelChangeIx(params: {
  payer: PublicKey;
  pocket: PublicKey;
  proof: OwnerProofFields;
}) {
  const w = new BorshWriter();
  writeOwnerProof(w, params.proof);
  return ownerActionIx("cancel_change", params.payer, params.pocket, w.out());
}

export function executeChangeIx(payer: PublicKey, pocket: PublicKey) {
  return new TransactionInstruction({
    programId: POCKET,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: false },
      { pubkey: pocket, isSigner: false, isWritable: true },
    ],
    data: data("execute_change"),
  });
}

function ownerActionIx(name: string, payer: PublicKey, pocket: PublicKey, body: Uint8Array) {
  return new TransactionInstruction({
    programId: POCKET,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: pocket, isSigner: false, isWritable: true },
      { pubkey: registryTreePda(), isSigner: false, isWritable: false },
    ],
    data: data(name, body),
  });
}
