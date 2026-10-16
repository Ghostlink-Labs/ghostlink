//! The incremental Merkle frontier and root-history ring both trees use
//! (build plan, section 5). Appending touches 26 Poseidon syscalls; the
//! zero-subtree constants are compiled in (`zeros.rs`, generated from the
//! shared fixtures and cross-checked by a test).

use crate::poseidon::node;
use crate::zeros::ZEROS;
use crate::VerifierError;

pub const TREE_DEPTH: usize = 26;
pub const ROOT_HISTORY: usize = 128;

/// The on-chain tree state: a frontier of filled-subtree hashes plus the
/// next leaf index. The caller owns the actual account layout; this is
/// pure logic over borrowed fields.
pub struct Frontier<'a> {
    pub next_index: &'a mut u64,
    pub frontier: &'a mut [[u8; 32]; TREE_DEPTH],
}

impl Frontier<'_> {
    /// Append a leaf and return the new root.
    pub fn append(&mut self, leaf: [u8; 32]) -> Result<[u8; 32], VerifierError> {
        let index = *self.next_index;
        if index >= 1u64 << TREE_DEPTH {
            return Err(VerifierError::TreeFull);
        }
        let mut cur = leaf;
        let mut idx = index;
        for level in 0..TREE_DEPTH {
            if idx % 2 == 0 {
                self.frontier[level] = cur;
                cur = node(&cur, &ZEROS[level])?;
            } else {
                cur = node(&self.frontier[level], &cur)?;
            }
            idx /= 2;
        }
        *self.next_index = index + 1;
        Ok(cur)
    }
}

/// Ring buffer of the last `ROOT_HISTORY` roots, so proofs built against
/// a slightly stale root still verify. Never check against a single
/// current root (threat model: stale root attack).
pub struct RootRing<'a> {
    pub roots: &'a mut [[u8; 32]; ROOT_HISTORY],
    pub cursor: &'a mut u8,
}

impl RootRing<'_> {
    pub fn push(&mut self, root: [u8; 32]) {
        let next = (*self.cursor as usize + 1) % ROOT_HISTORY;
        self.roots[next] = root;
        *self.cursor = next as u8;
    }

    pub fn contains(&self, root: &[u8; 32]) -> bool {
        self.roots.iter().any(|r| r == root)
    }
}

/// The empty tree's root (all-zero leaves).
pub fn empty_root() -> [u8; 32] {
    ZEROS[TREE_DEPTH]
}

/// Raw-layout reader for a TreeState account owned by the registry or
/// census program, so the pocket program can check root membership
/// without a cross-program call. Layout (after the 8-byte anchor
/// discriminator): next_index u64 | frontier [32 x 26] | roots [32 x 128]
/// | cursor u8 | padding [7].
pub mod tree_account {
    use super::{ROOT_HISTORY, TREE_DEPTH};

    pub const ROOTS_OFFSET: usize = 8 + 8 + 32 * TREE_DEPTH;
    pub const TOTAL_LEN: usize = ROOTS_OFFSET + 32 * ROOT_HISTORY + 1 + 7;

    /// True when `root` is one of the account's last 128 roots. The
    /// caller must have verified the account's owner program id.
    pub fn ring_contains(data: &[u8], root: &[u8; 32]) -> bool {
        if data.len() < TOTAL_LEN {
            return false;
        }
        for i in 0..ROOT_HISTORY {
            let off = ROOTS_OFFSET + i * 32;
            if &data[off..off + 32] == root {
                return true;
            }
        }
        false
    }
}
