/** Local-fork test support. Synthetic quotes/prices; never a production price source. */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, PublicKey, TransactionInstruction, type AccountInfo } from "@solana/web3.js";
import { ataAddress, TOKEN } from "@ghostlink/service-kit";
import { JupiterPlanner, JUPITER } from "@ghostlink/solver/jupiter";
import { RAYDIUM_CP, RAYDIUM_AUTHORITY, readPool, checkPoolSnapshot, type ApprovedPool, type RaydiumPool } from "@ghostlink/solver/raydium";
import type { RoutePlanner } from "@ghostlink/solver/server";
import { label, priceAccountFor, pythAccountData, PYTH_RECEIVER } from "./genesis.js";

const NATIVE = "So11111111111111111111111111111111111111112";
const EVENT = new PublicKey("D8cy77BBepLMngZx6ZukaTff5hCt1HrWyKk3Hnd9oitf");
export interface JupiterFixture {
  approval: ApprovedPool;
  inputDecimals: number;
  outputDecimals: number;
  programs: { id: string; sha256: string; file: string }[];
}
function jsonFile(path: string): any {
  if (statSync(path).size > 1_048_576) throw new Error("fixture JSON too large");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function loadJupiterFixture(directory: string): JupiterFixture {
  return jsonFile(join(directory, "fixture.json")) as JupiterFixture;
}
function reserves(pool: Buffer, a: Buffer, b: Buffer): [bigint, bigint] {
  return [a.readBigUInt64LE(64) - pool.readBigUInt64LE(341) - pool.readBigUInt64LE(357) - pool.readBigUInt64LE(397),
    b.readBigUInt64LE(64) - pool.readBigUInt64LE(349) - pool.readBigUInt64LE(365) - pool.readBigUInt64LE(405)];
}

/** Convert read-only snapshots into disposable genesis accounts; no RPC or key loading. */
export function prepareJupiterGenesis(source: string, destination: string): JupiterFixture {
  const snapshot = jsonFile(join(source, "snapshot.json"));
  const approval = snapshot.approval as ApprovedPool;
  if (approval.token0 !== NATIVE || !Number.isInteger(approval.maxTradeFeePpm) || approval.maxTradeFeePpm < 0 || approval.maxTradeFeePpm > 50_000) {
    throw new Error("fork fixture requires wrapped SOL token0 and a bounded pool fee");
  }
  const entries = snapshot.accounts as { pubkey: string; account: { data: [string, string]; owner: string; lamports: number; executable: boolean } }[];
  if (!Array.isArray(entries) || entries.length !== 9) throw new Error("expected seven pool accounts and two program accounts");
  const accounts: AccountInfo<Buffer>[] = entries.map(e => {
    if (e.account.data[1] !== "base64" || !Number.isSafeInteger(e.account.lamports) || e.account.lamports < 0) throw new Error("invalid snapshot encoding");
    return { ...e.account, data: Buffer.from(e.account.data[0], "base64"), owner: new PublicKey(e.account.owner), rentEpoch: 0 };
  });
  const pool = readPool(accounts[0], approval);
  const expected = [pool.address, pool.config, pool.vault0, pool.vault1, pool.mint0, pool.mint1, pool.observation, JUPITER, RAYDIUM_CP];
  if (entries.some((e, i) => e.pubkey !== expected[i]!.toBase58())) throw new Error("snapshot account order differs from pool");
  checkPoolSnapshot(accounts, approval, pool);
  if (accounts[0]!.data[390] !== 0) throw new Error("fixture quote calculator does not support creator fees");
  const [reserve0, reserve1] = reserves(accounts[0]!.data, accounts[2]!.data, accounts[3]!.data);
  if (reserve0 <= 0n || reserve1 <= 0n) throw new Error("empty fixture pool");
  const inputDecimals = accounts[4]!.data[44]!, outputDecimals = accounts[5]!.data[44]!;
  const price0 = 15_625_000_000n;
  const price1 = price0 * reserve0 * 10n ** BigInt(outputDecimals) / (reserve1 * 10n ** BigInt(inputDecimals));
  if (price1 <= 0n || price1 > 0x7fffffffffffffffn) throw new Error("unsupported synthetic oracle price");
  const programs = (jsonFile(join(source, "programs.json")) as { id: string; sha256: string }[]).map(p => {
    if (![JUPITER.toBase58(), RAYDIUM_CP.toBase58()].includes(p.id) || !/^[a-f0-9]{64}$/.test(p.sha256)) throw new Error("unexpected fixture program");
    const file = resolve(source, `${p.id}.so`);
    if (statSync(file).size > 4_194_304 || createHash("sha256").update(readFileSync(file)).digest("hex") !== p.sha256) throw new Error("fixture program hash differs");
    return { id: p.id, sha256: p.sha256, file };
  });
  if (programs.length !== 2 || new Set(programs.map(p => p.id)).size !== 2) throw new Error("both reviewed binaries required");
  mkdirSync(join(destination, "accounts"), { recursive: true });
  for (const entry of entries.slice(0, 7)) writeFileSync(join(destination, "accounts", `${entry.pubkey}.json`),
    JSON.stringify({ ...entry, account: { ...entry.account, rentEpoch: 0 } }));
  const publishTime = BigInt(Math.floor(Date.now() / 1000) + 86_400); // Synthetic localnet only, as in the inventory harness.
  for (const [tag, feed, price] of [["e2e usdc price acct", "usdc pyth feed", price0], ["e2e sol price acct", "sol pyth feed", price1]] as const) {
    const pubkey = priceAccountFor(tag).toBase58();
    writeFileSync(join(destination, "accounts", `${pubkey}.json`), JSON.stringify({ pubkey, account: {
      data: [pythAccountData(label(feed), price, -8, publishTime).toString("base64"), "base64"],
      lamports: 10_000_000, owner: PYTH_RECEIVER, executable: false, rentEpoch: 0,
    } }));
  }
  const fixture = { approval, inputDecimals, outputDecimals, programs };
  writeFileSync(join(destination, "fixture.json"), JSON.stringify(fixture, null, 2));
  return fixture;
}

export function syncNative(account: PublicKey) {
  return new TransactionInstruction({ programId: TOKEN, keys: [{ pubkey: account, isSigner: false, isWritable: true }], data: Buffer.from([17]) });
}

export class JupiterForkPlanner implements RoutePlanner {
  readonly funding = "intent-input" as const;
  #planner: JupiterPlanner;
  #pool: RaydiumPool;
  readonly lookupAddresses: PublicKey[];
  private constructor(private chain: Connection, private fixture: JupiterFixture, pool: RaydiumPool) {
    this.#pool = pool;
    this.lookupAddresses = [pool.address, pool.config, pool.vault0, pool.vault1, pool.observation, JUPITER, RAYDIUM_CP, RAYDIUM_AUTHORITY, EVENT];
    this.#planner = new JupiterPlanner(chain, { apiKey: "synthetic-local-fork-no-provider-call", pools: [fixture.approval], slippageBps: 50 }, async url => {
      const q = new URL(String(url)).searchParams;
      const input = new PublicKey(q.get("inputMint")!), output = new PublicKey(q.get("outputMint")!);
      const amount = BigInt(q.get("amount")!), payer = new PublicKey(q.get("taker")!), destination = new PublicKey(q.get("destinationTokenAccount")!);
      const quoted = await this.quote(input, amount);
      const ix = this.instruction(payer, input, destination, amount, quoted, 50);
      return new Response(JSON.stringify({ inputMint: input.toBase58(), outputMint: output.toBase58(), inAmount: amount.toString(), outAmount: quoted.toString(),
        otherAmountThreshold: (quoted * 9950n / 10000n).toString(), swapMode: "ExactIn", slippageBps: 50, transactionVersion: 0,
        routePlan: [{ percent: 100, bps: 10000, swapInfo: { ammKey: pool.address.toBase58(), label: "Raydium CP", inputMint: input.toBase58(), outputMint: output.toBase58(),
          inAmount: amount.toString(), outAmount: quoted.toString() } }], computeBudgetInstructions: [], setupInstructions: [], otherInstructions: [], cleanupInstruction: null,
        tipInstruction: null, addressesByLookupTableAddress: {}, swapInstruction: { programId: JUPITER.toBase58(), data: ix.data.toString("base64"),
          accounts: ix.keys.map(k => ({ ...k, pubkey: k.pubkey.toBase58() })) } }), { headers: { "content-type": "application/json" } });
    });
  }
  static async create(chain: Connection, fixture: JupiterFixture) {
    const pool = readPool(await chain.getAccountInfo(new PublicKey(fixture.approval.pool)), fixture.approval);
    return new JupiterForkPlanner(chain, fixture, pool);
  }
  plan(...args: Parameters<RoutePlanner["plan"]>) { return this.#planner.plan(...args); }
  async quote(input: PublicKey, amount: bigint): Promise<bigint> {
    const p = this.#pool;
    if (!input.equals(p.mint0) && !input.equals(p.mint1)) throw new Error("unsupported fixture mint");
    const values = await this.chain.getMultipleAccountsInfo([p.address, p.config, p.vault0, p.vault1]);
    if (values.some(a => !a) || values[0]!.data[390] !== 0) throw new Error("unsupported fixture fee model");
    const [a, b] = reserves(values[0]!.data, values[2]!.data, values[3]!.data);
    const fee = values[1]!.data.readBigUInt64LE(12), net = amount - (amount * fee + 999_999n) / 1_000_000n;
    const [reserveIn, reserveOut] = input.equals(p.mint0) ? [a, b] : [b, a];
    const output = net * reserveOut / (reserveIn + net);
    if (net <= 0n || output <= 0n) throw new Error("fixture quote rounds to zero");
    return output;
  }
  instruction(payer: PublicKey, input: PublicKey, destination: PublicKey, amount: bigint, quoted: bigint, slippage: number): TransactionInstruction {
    const p = this.#pool, forward = input.equals(p.mint0), output = forward ? p.mint1 : p.mint0, source = ataAddress(payer, input);
    const data = Buffer.alloc(39); data.set([187,100,250,204,49,196,175,20]); data.writeBigUInt64LE(amount, 8); data.writeBigUInt64LE(quoted, 16);
    data.writeUInt16LE(slippage, 24); data.writeUInt32LE(1, 30); data[34] = 46; data.writeUInt16LE(10000, 35); data[38] = 1;
    const m = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
    return new TransactionInstruction({ programId: JUPITER, data, keys: [m(payer, false, true), m(source, true), m(destination, true), m(input), m(output),
      m(TOKEN), m(TOKEN), m(JUPITER), m(EVENT), m(JUPITER), m(RAYDIUM_CP), m(payer, false, true), m(RAYDIUM_AUTHORITY), m(p.config), m(p.address, true),
      m(source, true), m(destination, true), m(forward ? p.vault0 : p.vault1, true), m(forward ? p.vault1 : p.vault0, true), m(TOKEN), m(TOKEN), m(input), m(output), m(p.observation, true)] });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.PAYER_KEYPAIR) throw new Error("fork fixture does not accept funded payer keys");
  const [, , source, destination] = process.argv;
  if (!source || !destination) throw new Error("usage: jupiter-fixture.js snapshot-directory output-directory");
  prepareJupiterGenesis(resolve(source), resolve(destination));
  console.log("Prepared local fork accounts and verified both program hashes; prices and quotes are synthetic.");
}
