import {
  type FieldElement, findProgramAddress, pk, pocketPda, SPL_TOKEN_PROGRAM_ID, toBase58, u64le,
} from "@ghostlink/common";

export type FundingAsset =
  | { kind: "sol"; lamports: bigint }
  | { kind: "spl"; mint: Uint8Array; rawAmount: bigint };

/** Values approved by the user, never inferred from an Actions response. */
export interface FundingApproval {
  appId: FieldElement;
  funder: Uint8Array;
  asset: FundingAsset;
  /** Fresh blockhash from an independently trusted, genesis-checked RPC. */
  recentBlockhash: Uint8Array;
}

const SYSTEM = new Uint8Array(32);
const TOKEN = pk(SPL_TOKEN_PROGRAM_ID);
const ATA = pk("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
function key(value: Uint8Array): Uint8Array {
  if (!(value instanceof Uint8Array) || value.length !== 32) throw new Error("funding approval requires 32-byte keys and blockhash");
  return Uint8Array.from(value);
}

/**
 * Check the exact unsigned legacy deposit supplied by GhostLink Actions and
 * return a detached copy with the caller's trusted recent blockhash substituted.
 * Supports only one SOL transfer, or idempotent pocket ATA creation followed by
 * one classic SPL transfer. No extra signers, accounts or fee-setting instructions.
 *
 * This is structural validation, not chain/account/fee evidence or permission to
 * trade. The caller must check the RPC genesis, confirmed PocketV3/mint/accounts,
 * chain header, transaction fee and possible ATA rent, and show them for consent.
 * Sign only the returned bytes; do not append instructions. This function never
 * calls a wallet, signs, sends, or confirms a transaction. V2 remains localnet only.
 */
export function prepareFundingTransaction(transaction: Uint8Array, approval: FundingApproval): Uint8Array {
  if (!(transaction instanceof Uint8Array) || transaction.length > 1232) throw new Error("invalid funding transaction size");
  // Uint8Array.from also copies Node Buffers; Buffer.slice would retain aliases.
  const bytes = Uint8Array.from(transaction);
  const funder = key(approval.funder), blockhash = key(approval.recentBlockhash);
  if (!blockhash.some(b => b !== 0)) throw new Error("invalid funding blockhash");
  const pocket = pocketPda(approval.appId).address;
  const asset = approval.asset;
  if (asset.kind !== "sol" && asset.kind !== "spl") throw new Error("unsupported funding asset");
  const amount = asset.kind === "sol" ? asset.lamports : asset.rawAmount;
  if (typeof amount !== "bigint" || amount <= 0n || amount > 0xffffffffffffffffn) throw new Error("funding amount must be a positive u64");
  type Instruction = { program: Uint8Array; accounts: Uint8Array[]; data: Uint8Array };
  let writable: Uint8Array[], readonly: Uint8Array[], instructions: Instruction[];
  if (asset.kind === "sol") {
    writable = [funder, pocket]; readonly = [SYSTEM];
    instructions = [{ program: SYSTEM, accounts: [funder, pocket], data: Uint8Array.of(2, 0, 0, 0, ...u64le(amount)) }];
  } else {
    const mint = key(asset.mint);
    const ata = (owner: Uint8Array) => findProgramAddress([owner, TOKEN, mint], ATA).address;
    const source = ata(funder), destination = ata(pocket);
    writable = [funder, source, destination]; readonly = [pocket, mint, SYSTEM, TOKEN, ATA];
    instructions = [
      { program: ATA, accounts: [funder, destination, pocket, mint, SYSTEM, TOKEN], data: Uint8Array.of(1) },
      { program: TOKEN, accounts: [source, destination, funder], data: Uint8Array.of(3, ...u64le(amount)) },
    ];
  }
  const permissions = new Map([...writable.map(k => [toBase58(k), true] as const), ...readonly.map(k => [toBase58(k), false] as const)]);
  const accountCount = writable.length + readonly.length;
  if (permissions.size !== accountCount) throw new Error("funding approval has overlapping account roles");
  let offset = 0;
  const take = (count: number): Uint8Array => {
    if (offset + count > bytes.length) throw new Error("truncated funding transaction");
    const part = bytes.subarray(offset, offset + count); offset += count; return part;
  };
  const byte = () => take(1)[0]!;
  const expectByte = (expected: number) => {
    if (byte() !== expected) throw new Error("unexpected funding transaction layout");
  };
  // Every compact length in these two bounded formats is below 128. Matching
  // its single-byte encoding also refuses overlong/noncanonical short vectors.
  expectByte(1);
  if (take(64).some(b => b !== 0)) throw new Error("funding transaction must be unsigned");
  expectByte(1); // legacy message, exactly one signer (rejects all version prefixes)
  expectByte(0); // the fee payer is writable
  expectByte(readonly.length);
  expectByte(accountCount);
  const accounts: Uint8Array[] = [], seen = new Set<string>();
  for (let i = 0; i < accountCount; i++) {
    const address = take(32), encoded = toBase58(address);
    if (seen.has(encoded) || permissions.get(encoded) !== (i < writable.length)) throw new Error("unexpected funding account or permission");
    seen.add(encoded); accounts.push(address);
  }
  if (!equal(accounts[0]!, funder)) throw new Error("funding signer/fee payer does not match approval");
  const blockhashOffset = offset;
  take(32);
  expectByte(instructions.length);
  const account = () => {
    const address = accounts[byte()];
    if (!address) throw new Error("invalid funding account index");
    return address;
  };
  for (const instruction of instructions) {
    if (!equal(account(), instruction.program)) throw new Error("unexpected funding program");
    expectByte(instruction.accounts.length);
    for (const expected of instruction.accounts) {
      if (!equal(account(), expected)) throw new Error("funding instruction account does not match approval");
    }
    expectByte(instruction.data.length);
    if (!equal(take(instruction.data.length), instruction.data)) throw new Error("funding instruction or amount does not match approval");
  }
  if (offset !== bytes.length) throw new Error("trailing funding transaction data");
  bytes.set(blockhash, blockhashOffset);
  return bytes;
}
