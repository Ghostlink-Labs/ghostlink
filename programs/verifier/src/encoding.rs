//! Field encoding: the same hi/lo split and big-endian conventions as
//! `@ghostlink/common` (vector-tested against the shared fixtures).

/// Split 32 bytes into two field elements, each returned as a 32-byte
/// big-endian value: hi = bytes[0..16], lo = bytes[16..32].
pub fn split32(bytes: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..].copy_from_slice(&bytes[..16]);
    lo[16..].copy_from_slice(&bytes[16..]);
    (hi, lo)
}

/// A u64 as a 32-byte big-endian field element.
pub fn u64_fe(v: u64) -> [u8; 32] {
    let mut out = [0u8; 32];
    out[24..].copy_from_slice(&v.to_be_bytes());
    out
}

pub const ZERO_FE: [u8; 32] = [0u8; 32];

/// A field element holding 1 (the app_id domain separator).
pub const ONE_FE: [u8; 32] = {
    let mut out = [0u8; 32];
    out[31] = 1;
    out
};

/// The BN254 scalar field modulus, big-endian.
pub const FIELD_MODULUS_BE: [u8; 32] = [
    0x30, 0x64, 0x4e, 0x72, 0xe1, 0x31, 0xa0, 0x29, 0xb8, 0x50, 0x45, 0xb6, 0x81, 0x81, 0x58,
    0x5d, 0x28, 0x33, 0xe8, 0x48, 0x79, 0xb9, 0x70, 0x91, 0x43, 0xe1, 0xf5, 0x93, 0xf0, 0x00,
    0x00, 0x01,
];

/// Reduce 32 big-endian bytes (e.g. a SHA-256 digest) into the field by
/// repeated subtraction — the modulus is ~2^253.6, so at most a handful
/// of rounds. Mirrors `hashToField` in @ghostlink/common.
pub fn reduce_to_field(bytes: &[u8; 32]) -> [u8; 32] {
    let mut v = *bytes;
    while !is_in_field(&v) {
        let mut borrow = 0i16;
        for i in (0..32).rev() {
            let d = v[i] as i16 - FIELD_MODULUS_BE[i] as i16 - borrow;
            if d < 0 {
                v[i] = (d + 256) as u8;
                borrow = 1;
            } else {
                v[i] = d as u8;
                borrow = 0;
            }
        }
    }
    v
}

/// True if the 32 big-endian bytes encode a value < the field modulus.
pub fn is_in_field(bytes: &[u8; 32]) -> bool {
    for i in 0..32 {
        if bytes[i] < FIELD_MODULUS_BE[i] {
            return true;
        }
        if bytes[i] > FIELD_MODULUS_BE[i] {
            return false;
        }
    }
    false // equal to the modulus is out of range
}
