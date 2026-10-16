/** snarkjs ships no type declarations; the surface used here is tiny. */
declare module "snarkjs" {
  export const groth16: {
    verify(vk: object, publicSignals: string[], proof: object): Promise<boolean>;
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array,
      zkey: string | Uint8Array,
    ): Promise<{ proof: object; publicSignals: string[] }>;
  };
}
