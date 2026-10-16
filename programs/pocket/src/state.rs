//! Account state, policy, events and errors for the pocket program.

use anchor_lang::prelude::*;
use solana_sha256_hasher::hashv;

/// 24 hours in slots (400 ms slots), used for the change timelock and the
/// daily spending window.
pub const TIMELOCK_SLOTS: u64 = 216_000;
pub const SLOTS_PER_DAY: u64 = 216_000;

/// How stale the census snapshot behind a holdings claim may be.
pub const MAX_MIN_SLOT_LAG: u64 = 9_000; // ~1 hour

/// How stale an oracle price may be, in seconds.
pub const MAX_ORACLE_AGE_SECS: i64 = 60;

/// Intent nonces live in a sliding window of `NONCE_WINDOW` values that
/// starts at `Pocket::nonce_base`. Any nonce inside the window can be
/// used once, in any order; a nonce beyond it slides the window forward
/// and forgets the oldest values, so a counter can run for the pocket's
/// whole life. A nonce below the window is treated as used.
pub const NONCE_BITMAP_BYTES: usize = 256;
pub const NONCE_WINDOW: u64 = (NONCE_BITMAP_BYTES * 8) as u64;

pub const SESSION_KIND_ED25519: u8 = 0;
pub const SESSION_KIND_P256: u8 = 1;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct OracleFeedBinding {
    pub mint: Pubkey,
    pub feed_id: [u8; 32],
    /// The mint's decimals, pinned by the user so valuation never trusts
    /// a passed-in mint account.
    pub decimals: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct Policy {
    pub daily_cap_usd_e6: u64,
    pub max_slippage_bps: u16,
    pub big_action_threshold_usd_e6: u64,
    pub no_oracle_cap_usd_e6: u64,
    pub session_max_slots: u64,
    #[max_len(8)]
    pub allowed_out_mints: Vec<Pubkey>,
    #[max_len(8)]
    pub oracle_feeds: Vec<OracleFeedBinding>,
}

impl Policy {
    pub fn validate(&self) -> bool {
        self.allowed_out_mints.len() <= 8
            && self.oracle_feeds.len() <= 8
            && self.max_slippage_bps <= 10_000
    }

    /// Canonical bytes, byte-for-byte the layout in
    /// `packages/common/src/intent.ts` (`policyBytes`) — vector-tested.
    pub fn canonical_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(35 + 1 + self.allowed_out_mints.len() * 32
            + 1 + self.oracle_feeds.len() * 65);
        out.extend_from_slice(&self.daily_cap_usd_e6.to_le_bytes());
        out.extend_from_slice(&self.max_slippage_bps.to_le_bytes());
        out.extend_from_slice(&self.big_action_threshold_usd_e6.to_le_bytes());
        out.extend_from_slice(&self.no_oracle_cap_usd_e6.to_le_bytes());
        out.extend_from_slice(&self.session_max_slots.to_le_bytes());
        out.push(self.allowed_out_mints.len() as u8);
        for m in &self.allowed_out_mints {
            out.extend_from_slice(&m.to_bytes());
        }
        out.push(self.oracle_feeds.len() as u8);
        for f in &self.oracle_feeds {
            out.extend_from_slice(&f.mint.to_bytes());
            out.extend_from_slice(&f.feed_id);
            out.push(f.decimals);
        }
        out
    }

    pub fn hash(&self) -> [u8; 32] {
        hashv(&[&self.canonical_bytes()]).to_bytes()
    }

    pub fn feed_for(&self, mint: &Pubkey) -> Option<&OracleFeedBinding> {
        self.oracle_feeds.iter().find(|f| &f.mint == mint)
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub enum Change {
    Home(Pubkey),
    Policy(Policy),
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, Debug, InitSpace)]
pub struct PendingChange {
    pub change: Change,
    pub executable_after_slot: u64,
}

#[account]
#[derive(InitSpace)]
pub struct Pocket {
    pub app_id: [u8; 32],
    pub domain_hash: [u8; 32],
    /// The only address this pocket can ever withdraw to.
    pub home: Pubkey,
    pub session_kind: u8,
    pub session_key: [u8; 33],
    pub session_expiry_slot: u64,
    pub policy: Policy,
    pub pending: Option<PendingChange>,
    pub day_start_slot: u64,
    pub spent_today_usd_e6: u64,
    pub nonce_bitmap: [u8; NONCE_BITMAP_BYTES],
    pub bump: u8,
    /// The latest expiry any session of this pocket was ever opened with.
    /// A new session must expire later, so a captured `open_session`
    /// (proof and all) cannot be replayed to reinstate a revoked or
    /// superseded session.
    pub max_session_expiry_slot: u64,
    /// Lowest nonce the window still accepts (see `NONCE_WINDOW`).
    pub nonce_base: u64,
    /// Freshness for every owner/session administrative authorization.
    pub owner_action_nonce: u64,
}

impl Pocket {
    pub fn consume_owner_action(&mut self) -> Result<()> {
        self.owner_action_nonce = self.owner_action_nonce.checked_add(1)
            .ok_or(error!(PocketError::Overflow))?;
        Ok(())
    }

    pub fn nonce_used(&self, nonce: u64) -> bool {
        nonce_window::is_used(self.nonce_base, &self.nonce_bitmap, nonce)
    }

    pub fn mark_nonce(&mut self, nonce: u64) {
        nonce_window::mark(&mut self.nonce_base, &mut self.nonce_bitmap, nonce)
    }

    /// Roll the daily spending window forward if a day has passed.
    pub fn roll_day(&mut self, now_slot: u64) {
        if now_slot >= self.day_start_slot.saturating_add(SLOTS_PER_DAY) {
            self.day_start_slot = now_slot;
            self.spent_today_usd_e6 = 0;
        }
    }

    /// The 32 bytes that enter the session commitment: the Ed25519 key
    /// itself, or SHA-256 of the 33-byte compressed P-256 key.
    pub fn session_key32(kind: u8, key: &[u8; 33]) -> [u8; 32] {
        if kind == SESSION_KIND_P256 {
            hashv(&[key]).to_bytes()
        } else {
            let mut out = [0u8; 32];
            out.copy_from_slice(&key[..32]);
            out
        }
    }
}

/// The sliding nonce window over a fixed bitmap: bit `nonce % NONCE_WINDOW`
/// belongs to `nonce` while `nonce_base <= nonce < nonce_base + NONCE_WINDOW`.
pub mod nonce_window {
    use super::{NONCE_BITMAP_BYTES, NONCE_WINDOW};

    fn bit(bits: &[u8; NONCE_BITMAP_BYTES], nonce: u64) -> bool {
        let i = (nonce % NONCE_WINDOW) as usize;
        (bits[i / 8] >> (i % 8)) & 1 == 1
    }

    fn set(bits: &mut [u8; NONCE_BITMAP_BYTES], nonce: u64, on: bool) {
        let i = (nonce % NONCE_WINDOW) as usize;
        if on {
            bits[i / 8] |= 1 << (i % 8);
        } else {
            bits[i / 8] &= !(1 << (i % 8));
        }
    }

    /// Below the window counts as used; beyond it is fresh (it will slide).
    pub fn is_used(base: u64, bits: &[u8; NONCE_BITMAP_BYTES], nonce: u64) -> bool {
        if nonce < base {
            return true;
        }
        if nonce - base >= NONCE_WINDOW {
            return false;
        }
        bit(bits, nonce)
    }

    /// Marks `nonce` used, sliding the window forward first if needed.
    pub fn mark(base: &mut u64, bits: &mut [u8; NONCE_BITMAP_BYTES], nonce: u64) {
        if nonce < *base {
            return;
        }
        if nonce - *base >= NONCE_WINDOW {
            let new_base = nonce - (NONCE_WINDOW - 1);
            if new_base - *base >= NONCE_WINDOW {
                *bits = [0u8; NONCE_BITMAP_BYTES];
            } else {
                // Only the values leaving the window lose their bit; the
                // rest keep their position since the mapping is circular.
                for v in *base..new_base {
                    set(bits, v, false);
                }
            }
            *base = new_base;
        }
        set(bits, nonce, true);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn window_slides_and_forgets() {
            let mut base = 0u64;
            let mut bits = [0u8; NONCE_BITMAP_BYTES];
            mark(&mut base, &mut bits, 7);
            assert!(is_used(base, &bits, 7));
            assert!(!is_used(base, &bits, 8));
            assert!(!is_used(base, &bits, 2047));
            assert!(!is_used(base, &bits, 5000), "beyond the window is fresh");

            mark(&mut base, &mut bits, 5000);
            assert_eq!(base, 5000 - (NONCE_WINDOW - 1));
            assert!(is_used(base, &bits, 5000));
            assert!(is_used(base, &bits, 7), "below the window reads as used");
            assert!(is_used(base, &bits, base - 1));
            assert!(!is_used(base, &bits, base));
            assert!(!is_used(base, &bits, 4999));

            // A value whose bit position collides with an old nonce must
            // start clean after the slide.
            let collides = 7 + NONCE_WINDOW * 2; // same bit as 7, inside the window
            assert!(!is_used(base, &bits, collides));

            // A huge jump clears everything.
            mark(&mut base, &mut bits, 1_000_000);
            assert_eq!(base, 1_000_000 - (NONCE_WINDOW - 1));
            assert!(is_used(base, &bits, 1_000_000));
            for v in base..1_000_000 {
                assert!(!is_used(base, &bits, v));
            }
        }

        #[test]
        fn highest_nonce_is_used_once() {
            let mut base = 0;
            let mut bits = [0u8; NONCE_BITMAP_BYTES];
            mark(&mut base, &mut bits, u64::MAX - 1);
            assert!(is_used(base, &bits, u64::MAX - 1));
            assert!(!is_used(base, &bits, u64::MAX));
            mark(&mut base, &mut bits, u64::MAX);
            assert!(is_used(base, &bits, u64::MAX));
            assert!(is_used(base, &bits, u64::MAX - 1));
            assert!(!is_used(base, &bits, base));
            assert!(is_used(base, &bits, base - 1));
        }
    }
}

/// Transient per-fill state, created in fill_begin, closed in fill_end.
#[account]
#[derive(InitSpace)]
pub struct FillState {
    pub intent_hash: [u8; 32],
    pub in_mint: Pubkey,
    pub in_max: u64,
    pub out_mint: Pubkey,
    pub out_min: u64,
    pub out_balance_before: u64,
    pub in_value_usd_e6: u64,
    pub passkey_signed: bool,
    /// The token account whose balance `out_balance_before` snapshotted;
    /// `fill_end` must measure the very same account, or a second
    /// pocket-owned account with a standing balance would pass as delivery.
    pub out_account: Pubkey,
}

#[event]
pub struct SessionOpened {
    pub pocket: Pubkey,
    pub app_id: [u8; 32],
    pub created: bool,
    pub session_expiry_slot: u64,
}

#[event]
pub struct Filled {
    pub pocket: Pubkey,
    pub intent_hash: [u8; 32],
    pub in_mint: Pubkey,
    pub in_max: u64,
    pub out_mint: Pubkey,
    pub out_received: u64,
    pub in_value_usd_e6: u64,
}

#[event]
pub struct SweptHome {
    pub pocket: Pubkey,
    pub home: Pubkey,
}

#[event]
pub struct ChangeProposed {
    pub pocket: Pubkey,
    pub executable_after_slot: u64,
}

#[event]
pub struct ChangeExecuted {
    pub pocket: Pubkey,
}

#[event]
pub struct ChangeCanceled {
    pub pocket: Pubkey,
}

#[event]
pub struct SessionRevoked {
    pub pocket: Pubkey,
}

#[error_code]
pub enum PocketError {
    #[msg("must be a top-level instruction")]
    CpiForbidden,
    #[msg("value is not a reduced BN254 field element")]
    NotInField,
    #[msg("proof did not verify")]
    ProofInvalid,
    #[msg("registry root is not in the root history")]
    UnknownRegistryRoot,
    #[msg("census root is not in the root history")]
    UnknownCensusRoot,
    #[msg("census snapshot window is too old")]
    SnapshotTooOld,
    #[msg("invalid session key or kind")]
    BadSessionKey,
    #[msg("session expiry out of policy range")]
    BadSessionExpiry,
    #[msg("invalid policy")]
    BadPolicy,
    #[msg("policy required when creating a pocket")]
    PolicyRequired,
    #[msg("home address mismatch")]
    HomeMismatch,
    #[msg("domain mismatch for existing pocket")]
    DomainMismatch,
    #[msg("intent does not reference this pocket")]
    WrongPocket,
    #[msg("intent policy hash does not match the pocket policy")]
    PolicyHashMismatch,
    #[msg("intent deadline has passed")]
    DeadlinePassed,
    #[msg("session has expired")]
    SessionExpired,
    #[msg("nonce already used or out of range")]
    NonceUsed,
    #[msg("no signature precompile instruction immediately before")]
    MissingSignature,
    #[msg("malformed signature precompile payload")]
    BadSignatureInstruction,
    #[msg("precompile verified a different key")]
    WrongSigner,
    #[msg("precompile verified a different message")]
    WrongMessage,
    #[msg("webauthn client data rejected")]
    BadWebauthn,
    #[msg("no matching fill_end later in this transaction")]
    NoFillEnd,
    #[msg("another pocket instruction sits between fill_begin and fill_end")]
    FillInterleaved,
    #[msg("output mint not allowed by policy")]
    OutMintNotAllowed,
    #[msg("input mint has no oracle feed")]
    NoInputOracle,
    #[msg("daily cap exceeded")]
    DailyCapExceeded,
    #[msg("no-oracle intents need a passkey signature and the no-oracle cap")]
    NoOracleViolation,
    #[msg("intent exceeds the passkey threshold but was not passkey-signed")]
    PasskeyRequired,
    #[msg("output below the guaranteed minimum")]
    OutputTooLow,
    #[msg("output minimum below the oracle slippage floor")]
    SlippageFloor,
    #[msg("oracle account rejected")]
    BadOracle,
    #[msg("oracle price is stale")]
    StaleOracle,
    #[msg("token account rejected")]
    BadTokenAccount,
    #[msg("a pending change already exists")]
    ChangePending,
    #[msg("no pending change")]
    NoChangePending,
    #[msg("the timelock has not elapsed")]
    TimelockActive,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("Poseidon hash failed")]
    HashFailed,
    #[msg("session expiry must exceed every earlier session's expiry")]
    SessionReplayed,
    #[msg("fill_end output account differs from the one fill_begin snapshotted")]
    FillAccountMismatch,
}
