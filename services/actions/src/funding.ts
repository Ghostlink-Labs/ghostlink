import { PublicKey, SystemProgram, Transaction, type AccountInfo, type Connection } from "@solana/web3.js";
import { TOKEN, ataAddress, badRequest, createAtaIdempotentIx, pocketPda, readPocketAccount, splTransferIx } from "@ghostlink/service-kit";
import type { ActionsOperations } from "./operations.js";

type Info = AccountInfo<Buffer> | null;
function token(info: Info, owner: PublicKey, mint: PublicKey, destination: boolean): bigint {
  if (!info || info.executable || !info.owner.equals(TOKEN) || info.data.length !== 165 || info.data[108] !== 1 ||
    !info.data.subarray(0, 32).equals(mint.toBuffer()) || !info.data.subarray(32, 64).equals(owner.toBuffer())) throw badRequest("token account unavailable or unsupported");
  const delegate = info.data.readUInt32LE(72), close = info.data.readUInt32LE(129), native = info.data.readUInt32LE(109);
  if (delegate > 1 || close > 1 || native > 1 || (destination && (delegate !== 0 ||
    (close !== 0 && !info.data.subarray(133, 165).equals(owner.toBuffer()))))) throw badRequest("token account has unsupported authorities");
  return info.data.readBigUInt64LE(64);
}
function mint(info: Info): void {
  if (!info || info.executable || !info.owner.equals(TOKEN) || info.data.length !== 82 || info.data[45] !== 1 ||
    info.data.readUInt32LE(0) > 1 || info.data.readUInt32LE(46) > 1) throw badRequest("initialized classic SPL mint required; Token-2022 is unsupported");
}

/** One contextual account snapshot; all destination addresses are derived locally. No signing or broadcast. */
export async function depositTransaction(connection: Connection, operations: ActionsOperations, user: PublicKey,
  appId: Uint8Array, amount: bigint, asset?: PublicKey): Promise<Transaction> {
  operations.assertFresh(); await operations.verifyChain();
  const pocket = pocketPda(appId), source = asset ? ataAddress(user, asset) : undefined, destination = asset ? ataAddress(pocket, asset) : undefined;
  if (user.equals(pocket)) throw badRequest("deposit wallet cannot be the pocket");
  const keys = asset ? [pocket, asset, source!, destination!] : [pocket];
  const response = await connection.getMultipleAccountsInfoAndContext(keys, { commitment: "confirmed", minContextSlot: operations.minimumSlot });
  operations.observe(response.context.slot);
  if (response.value.length !== keys.length || !response.value[0]) throw badRequest("funding accounts unavailable");
  try {
    const state = readPocketAccount(response.value[0]);
    if (!pocketPda(state.appId).equals(pocket) || !Buffer.from(state.appId).equals(Buffer.from(appId))) throw new Error();
  } catch { throw badRequest("no supported pocket is open for this app id"); }
  const tx = new Transaction();
  if (asset) {
    mint(response.value[1]!);
    if (token(response.value[2]!, user, asset, false) < amount) throw badRequest("insufficient token balance");
    const target = response.value[3]!;
    const absent = !target || (!target.executable && target.owner.equals(SystemProgram.programId) && target.data.length === 0);
    if (!absent) token(target, pocket, asset, true);
    tx.add(createAtaIdempotentIx(user, pocket, asset), splTransferIx(source!, destination!, user, amount));
  } else tx.add(SystemProgram.transfer({ fromPubkey: user, toPubkey: pocket, lamports: amount }));
  const latest = await connection.getLatestBlockhashAndContext({ commitment: "confirmed", minContextSlot: operations.minimumSlot });
  operations.observe(latest.context.slot); operations.assertFresh();
  if (!Number.isSafeInteger(latest.value.lastValidBlockHeight) || latest.value.lastValidBlockHeight < 0 ||
    new PublicKey(latest.value.blockhash).toBase58() !== latest.value.blockhash) throw new Error("invalid funding blockhash");
  tx.feePayer = user; tx.recentBlockhash = latest.value.blockhash; tx.lastValidBlockHeight = latest.value.lastValidBlockHeight;
  return tx;
}
