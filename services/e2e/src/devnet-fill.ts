/** V1 public-network runner is deliberately disabled for the incompatible V2 candidate. */
console.error("V2 has no verified devnet deployment. Use scripts/localnet-e2e.sh; preserve existing V1 programs.");
process.exitCode = 1;
export {};
