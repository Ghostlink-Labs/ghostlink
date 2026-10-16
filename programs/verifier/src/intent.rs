//! Canonical intent bytes — byte-for-byte the layout in
//! `packages/common/src/intent.ts` (vector-tested). The session key signs
//! SHA-256 of these bytes; the pocket program rebuilds them from the
//! instruction arguments and demands the precompile verified exactly them.

pub const INTENT_TAG: &[u8; 19] = b"ghostlink:intent:v1";
pub const INTENT_LEN: usize = 19 + 32 + 8 + 32 + 8 + 32 + 8 + 8 + 32; // 179

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Intent {
    pub pocket: [u8; 32],
    pub nonce: u64,
    pub in_mint: [u8; 32],
    pub in_max: u64,
    pub out_mint: [u8; 32],
    pub out_min: u64,
    pub deadline_slot: u64,
    pub policy_hash: [u8; 32],
}

impl Intent {
    pub fn to_bytes(&self) -> [u8; INTENT_LEN] {
        let mut out = [0u8; INTENT_LEN];
        let mut off = 0;
        let mut put = |bytes: &[u8], off: &mut usize| {
            out[*off..*off + bytes.len()].copy_from_slice(bytes);
            *off += bytes.len();
        };
        put(INTENT_TAG, &mut off);
        put(&self.pocket, &mut off);
        put(&self.nonce.to_le_bytes(), &mut off);
        put(&self.in_mint, &mut off);
        put(&self.in_max.to_le_bytes(), &mut off);
        put(&self.out_mint, &mut off);
        put(&self.out_min.to_le_bytes(), &mut off);
        put(&self.deadline_slot.to_le_bytes(), &mut off);
        put(&self.policy_hash, &mut off);
        debug_assert_eq!(off, INTENT_LEN);
        out
    }
}
