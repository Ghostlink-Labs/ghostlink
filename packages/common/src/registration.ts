/**
 * The one message a wallet ever signs (build plan 4.1).
 *
 * The message is printable ASCII so every wallet can display it, and every
 * binary part is encoded (hex for the commitment, base58 for keys). The
 * registry program reconstructs these exact bytes on-chain and checks the
 * Ed25519 precompile verified them.
 *
 *   ghostlink:register:v1
 *   commitment:<64 hex chars>
 *   wallet:<base58>
 *   program:<base58>
 *   cluster:<localnet|devnet|mainnet-beta>
 *
 * Lines are joined with "\n" and there is no trailing newline.
 *
 * For wallets that frame signatures with the Solana off-chain message
 * format (Ledger), `frameOffchain` wraps the same bytes; the registry
 * accepts both shapes.
 */
import { Cluster, REGISTER_TAG } from "./constants.js";
import { FieldElement, fieldToBytes32, bytesToHex } from "./field.js";
import { toBase58 } from "./pda.js";

export interface RegistrationParams {
  commitment: FieldElement;
  walletPubkey: Uint8Array;
  registryProgramId: Uint8Array;
  cluster: Cluster;
}

export function registrationMessage(p: RegistrationParams): Uint8Array {
  const lines = [
    REGISTER_TAG,
    `commitment:${bytesToHex(fieldToBytes32(p.commitment))}`,
    `wallet:${toBase58(p.walletPubkey)}`,
    `program:${toBase58(p.registryProgramId)}`,
    `cluster:${p.cluster}`,
  ];
  return new TextEncoder().encode(lines.join("\n"));
}

/**
 * Solana off-chain message signing format, version 0, format 0
 * (restricted ASCII, <= 1212 bytes, Ledger-compatible):
 *   "\xff" "solana offchain" | version u8 = 0 | format u8 = 0 | length u16 LE | message
 */
export function frameOffchain(message: Uint8Array): Uint8Array {
  if (message.length > 1212) throw new Error("message too long for format 0");
  for (const b of message) {
    if ((b < 0x20 || b > 0x7e) && b !== 0x0a) throw new Error("not printable ASCII");
  }
  // 16 raw bytes: 0xff then ASCII "solana offchain" (TextEncoder would
  // UTF-8-expand 0xff to two bytes, so build it by hand).
  const domain = new Uint8Array([0xff, ...new TextEncoder().encode("solana offchain")]);
  const out = new Uint8Array(domain.length + 4 + message.length);
  out.set(domain, 0);
  out[domain.length] = 0; // header version
  out[domain.length + 1] = 0; // message format
  out[domain.length + 2] = message.length & 0xff;
  out[domain.length + 3] = message.length >> 8;
  out.set(message, domain.length + 4);
  return out;
}
