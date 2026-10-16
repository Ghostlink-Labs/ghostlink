/** Regenerates programs/verifier/src/zeros.rs from the shared fixtures. */
import { readFileSync, writeFileSync } from "node:fs";

const v = JSON.parse(readFileSync("packages/common/fixtures/vectors.json", "utf8"));
const toBytes = (d) => {
  let n = BigInt(d);
  const b = [];
  for (let i = 0; i < 32; i++) {
    b.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return b;
};
const rows = v.merkle.zeros
  .map((z, i) => `    // level ${i}\n    [${toBytes(z).join(", ")}],`)
  .join("\n");
const out = `//! Zero-subtree constants for the depth-26 incremental trees, generated
//! from packages/common/fixtures/vectors.json (zeros[0] = Poseidon(0,0),
//! zeros[i+1] = Poseidon(zeros[i], zeros[i])). Do not edit by hand;
//! regenerate with: node scripts/gen-zeros.mjs
//! A test in tests/vectors.rs recomputes every entry.

pub const ZEROS: [[u8; 32]; 27] = [
${rows}
];
`;
writeFileSync("programs/verifier/src/zeros.rs", out);
console.log(`zeros.rs written, levels: ${v.merkle.zeros.length}`);
