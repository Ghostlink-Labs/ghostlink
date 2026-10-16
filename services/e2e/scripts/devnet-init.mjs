/** Initializes the registry and census trees on devnet (idempotent). */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Connection, Keypair, Transaction } from "@solana/web3.js";
import { initializeIx, registryTreePda, censusTreePda } from "@ghostlink/service-kit";

const url = process.env.DEVNET_RPC ?? "https://api.devnet.solana.com";
const connection = new Connection(url, "confirmed");
const payer = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(readFileSync(join(homedir(), ".ghostlink/keys/deployer.json"), "utf8"))),
);

for (const [name, pda, program] of [
  ["registry", registryTreePda(), "registry"],
  ["census", censusTreePda(), "census"],
]) {
  if (await connection.getAccountInfo(pda)) {
    console.log(`${name} tree: already initialized at ${pda.toBase58()}`);
    continue;
  }
  const tx = new Transaction().add(initializeIx(program, payer.publicKey));
  tx.feePayer = payer.publicKey;
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  tx.recentBlockhash = blockhash;
  tx.sign(payer);
  const sig = await connection.sendRawTransaction(tx.serialize());
  const status = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (status.value.err) throw new Error(`${name} initialization failed: ${JSON.stringify(status.value.err)}`);
  console.log(`${name} tree: initialized at ${pda.toBase58()} (${sig.slice(0, 16)}…)`);
}
console.log(`balance: ${(await connection.getBalance(payer.publicKey)) / 1e9} SOL`);
