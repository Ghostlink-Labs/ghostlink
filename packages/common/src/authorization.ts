import { sha256 } from "@noble/hashes/sha256";
import bs58 from "bs58";
import { CENSUS_PROGRAM_ID, POCKET_PROGRAM_ID, REGISTRY_PROGRAM_ID } from "./constants.js";
import { hashToField, type FieldElement } from "./field.js";
import { policyHash, type Policy } from "./intent.js";

/** Program identity binding; RPC genesis verification is a separate release gate. */
export interface SessionDeployment {
  pocketProgram: Uint8Array;
  registryProgram: Uint8Array;
  censusProgram: Uint8Array;
}

/** Fresh arrays on each call so caller mutation cannot change the defaults. */
export function developmentSessionDeployment(): SessionDeployment {
  return {
    pocketProgram: bs58.decode(POCKET_PROGRAM_ID),
    registryProgram: bs58.decode(REGISTRY_PROGRAM_ID),
    censusProgram: bs58.decode(CENSUS_PROGRAM_ID),
  };
}

/**
 * V2 login public signal 11. Zero is reserved for off-chain login only.
 * Pocket authorization binds the exact canonical policy, key kind and
 * deployment using SHA-256 reduced into BN254, like owner action hashes.
 * Home, session key/expiry and domain are bound by the other login signals.
 */
export function pocketAuthorizationContext(
  policy: Policy,
  sessionKind: number,
  deployment: SessionDeployment = developmentSessionDeployment(),
): FieldElement {
  if (sessionKind !== 0 && sessionKind !== 1) throw new Error("invalid session kind");
  const ids = [deployment.pocketProgram, deployment.registryProgram, deployment.censusProgram];
  for (const id of ids) {
    if (!(id instanceof Uint8Array) || id.length !== 32) throw new Error("deployment program must be 32 bytes");
  }
  const tag = new TextEncoder().encode("ghostlink:open-session:v2");
  const bytes = new Uint8Array(tag.length + 32 * 4 + 1);
  bytes.set(tag);
  ids.forEach((id, i) => bytes.set(id, tag.length + i * 32));
  bytes.set(policyHash(policy), tag.length + 96);
  bytes[bytes.length - 1] = sessionKind;
  return hashToField(sha256(bytes));
}
