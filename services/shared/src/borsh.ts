/**
 * Minimal borsh writer — just what the program arguments need. Every
 * integer is range-checked: a value that does not fit must fail here,
 * never wrap into a different (and possibly far more permissive) one.
 */
export class BorshWriter {
  private parts: number[] = [];

  u8(v: number): this {
    check(v, 0xff, "u8");
    this.parts.push(v);
    return this;
  }

  u16(v: number): this {
    check(v, 0xffff, "u16");
    this.parts.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  u32(v: number): this {
    check(v, 0xffffffff, "u32");
    for (let i = 0; i < 4; i++) this.parts.push((v >>> (8 * i)) & 0xff);
    return this;
  }

  u64(v: bigint): this {
    if (typeof v !== "bigint" || v < 0n || v > 0xffffffffffffffffn) throw new RangeError(`u64 out of range: ${v}`);
    let x = v;
    for (let i = 0; i < 8; i++) {
      this.parts.push(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }

  bool(v: boolean): this {
    return this.u8(v ? 1 : 0);
  }

  fixed(bytes: Uint8Array, expected?: number): this {
    if (expected !== undefined && bytes.length !== expected) {
      throw new Error(`expected ${expected} bytes, got ${bytes.length}`);
    }
    for (const b of bytes) this.parts.push(b);
    return this;
  }

  /** Vec<u8> and String: u32 length prefix then raw bytes. */
  bytes(bytes: Uint8Array): this {
    this.u32(bytes.length);
    return this.fixed(bytes);
  }

  option<T>(value: T | undefined | null, write: (w: this, v: T) => void): this {
    if (value === undefined || value === null) return this.u8(0);
    this.u8(1);
    write(this, value);
    return this;
  }

  vec<T>(items: readonly T[], write: (w: this, v: T) => void): this {
    this.u32(items.length);
    for (const item of items) write(this, item);
    return this;
  }

  out(): Uint8Array {
    return Uint8Array.from(this.parts);
  }
}

function check(v: number, max: number, what: string): void {
  if (!Number.isInteger(v) || v < 0 || v > max) throw new RangeError(`${what} out of range: ${v}`);
}
