import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountInfo,
} from "@solana/web3.js";
import {
  TOKEN,
  ataAddress,
  badRequest,
  createAtaIdempotentIx,
  pocketPda,
  readPocketAccount,
} from "@ghostlink/service-kit";

export interface SweepPair {
  source: PublicKey;
  destination?: PublicKey;
  mint?: PublicKey;
}
type Info = AccountInfo<Buffer> | null;
function token(
  info: Info,
  owner: PublicKey,
  mint: PublicKey,
  destination: boolean,
): boolean {
  if (
    !info ||
    info.executable ||
    !info.owner.equals(TOKEN) ||
    info.data.length !== 165 ||
    info.data[108] !== 1 ||
    !info.data.subarray(0, 32).equals(mint.toBuffer()) ||
    !info.data.subarray(32, 64).equals(owner.toBuffer())
  )
    return false;
  const delegate = info.data.readUInt32LE(72),
    close = info.data.readUInt32LE(129);
  if (delegate > 1 || close > 1) return false;
  return (
    !destination ||
    (delegate === 0 &&
      (close === 0 || info.data.subarray(133, 165).equals(owner.toBuffer())))
  );
}
const absent = (info: Info) =>
  !info ||
  (!info.executable &&
    info.owner.equals(SystemProgram.programId) &&
    info.data.length === 0);

/** Omitted destination explicitly asks for a safe home account, including a fresh auxiliary account if needed. */
export async function prepareRecoverySweep(
  connection: Connection,
  payer: PublicKey,
  pocket: PublicKey,
  home: PublicKey,
  pairs: readonly SweepPair[],
) {
  if (
    pairs.length > 16 ||
    new Set(pairs.map((p) => p.source.toBase58())).size !== pairs.length ||
    home.equals(pocket)
  )
    throw badRequest("invalid recovery sources or home");
  let floor = await connection.getSlot("confirmed");
  const accept = (slot: number) => {
    if (!Number.isSafeInteger(slot) || slot < 0 || slot < floor)
      throw new Error("stale recovery accounts");
    floor = slot;
  };
  accept(floor);
  const state = await connection.getAccountInfoAndContext(pocket, {
    commitment: "confirmed",
    minContextSlot: floor,
  });
  accept(state.context.slot);
  if (!state.value) throw badRequest("recovery pocket missing");
  const decoded = readPocketAccount(state.value);
  if (!decoded.home.equals(home) || !pocketPda(decoded.appId).equals(pocket))
    throw badRequest("recovery home mismatch");
  const instructions: TransactionInstruction[] = [],
    signers: Keypair[] = [],
    created = new Set<string>();
  const resolved: {
    source: PublicKey;
    destination: PublicKey;
    mint: PublicKey;
  }[] = [];
  let rent = 0n;
  if (!pairs.length) return { instructions, signers, rent, pairs: resolved };
  const sources = await connection.getMultipleAccountsInfoAndContext(
    pairs.map((p) => p.source),
    { commitment: "confirmed", minContextSlot: floor },
  );
  accept(sources.context.slot);
  if (sources.value.length !== pairs.length)
    throw new Error("incomplete recovery sources");
  const mints = pairs.map((p, i) => {
    const info = sources.value[i];
    if (!info || info.data.length !== 165)
      throw badRequest("invalid recovery source");
    const mint = p.mint ?? new PublicKey(info.data.subarray(0, 32));
    if (!token(info, pocket, mint, false))
      throw badRequest("invalid recovery source or mint");
    return mint;
  });
  const destinations = pairs.map(
    (p, i) => p.destination ?? ataAddress(home, mints[i]!),
  );
  const accounts = await connection.getMultipleAccountsInfoAndContext(
    destinations,
    { commitment: "confirmed", minContextSlot: floor },
  );
  accept(accounts.context.slot);
  if (accounts.value.length !== pairs.length)
    throw new Error("incomplete recovery destinations");
  let accountRent: number | undefined;
  const cost = async () => {
    accountRent ??= await connection.getMinimumBalanceForRentExemption(
      165,
      "confirmed",
    );
    if (!Number.isSafeInteger(accountRent) || accountRent <= 0)
      throw new Error("invalid recovery rent");
    return accountRent;
  };
  const automatic = new Map<string, PublicKey>();
  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i]!,
      mint = mints[i]!,
      info = accounts.value[i]!,
      canonical = ataAddress(home, mint);
    let destination = destinations[i]!;
    if (!pair.destination && automatic.has(mint.toBase58()))
      destination = automatic.get(mint.toBase58())!;
    else if (token(info, home, mint, true)) {
      /* Use an existing exclusively home-controlled account. */
    } else if (absent(info) && destination.equals(canonical)) {
      if (!created.has(destination.toBase58())) {
        rent += BigInt(await cost());
        instructions.push(createAtaIdempotentIx(payer, home, mint));
        created.add(destination.toBase58());
      }
    } else {
      if (pair.destination)
        throw badRequest(
          "recovery destination unavailable; omit destination for automatic home recovery",
        );
      const account = Keypair.generate(),
        lamports = await cost();
      destination = account.publicKey;
      signers.push(account);
      rent += BigInt(lamports);
      instructions.push(
        SystemProgram.createAccount({
          fromPubkey: payer,
          newAccountPubkey: destination,
          lamports,
          space: 165,
          programId: TOKEN,
        }),
        new TransactionInstruction({
          programId: TOKEN,
          keys: [
            { pubkey: destination, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([Buffer.from([18]), home.toBuffer()]),
        }),
      ); // InitializeAccount3: owner is always the confirmed home.
    }
    if (!pair.destination) automatic.set(mint.toBase58(), destination);
    resolved.push({ source: pair.source, destination, mint });
  }
  return { instructions, signers, rent, pairs: resolved };
}
