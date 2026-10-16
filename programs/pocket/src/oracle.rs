//! Pyth price reading and USD valuation.
//!
//! The pocket parses Pyth pull-oracle `PriceUpdateV2` accounts directly
//! (owner-checked against the Pyth receiver program) instead of linking
//! the receiver SDK, keeping the dependency surface auditable. Which feed
//! prices which mint is fixed in the pocket's policy by the user, so an
//! app or solver can never substitute a friendlier feed. Switchboard
//! support is a documented v2 candidate (docs/adr/0001).

use anchor_lang::prelude::*;

use crate::state::{PocketError, MAX_ORACLE_AGE_SECS};

/// Pyth receiver program (same id on devnet and mainnet).
pub const PYTH_RECEIVER_ID: Pubkey = pubkey!("rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ");

/// Anchor discriminator of PriceUpdateV2 = sha256("account:PriceUpdateV2")[..8].
pub const PRICE_UPDATE_V2_DISC: [u8; 8] = [34, 241, 35, 99, 157, 126, 244, 205];

/// Minimum byte length of PriceUpdateV2 up to the fields we read:
/// 8 disc + 32 write_authority + 2 verification level (worst case)
/// + 32 feed id + 8 price + 8 conf + 4 expo + 8 publish_time.
const MIN_LEN: usize = 8 + 32 + 2 + 32 + 8 + 8 + 4 + 8;

pub struct OraclePrice {
    pub price: i64,
    pub exponent: i32,
}

/// Parses and validates a PriceUpdateV2 account for `expected_feed_id`.
///
/// Layout after the discriminator:
///   write_authority: Pubkey (32)
///   verification_level: borsh enum — 0 => Partial { num_signatures: u8 }
///                       (one extra byte), 1 => Full
///   price_message: feed_id [32], price i64, conf u64, exponent i32,
///                  publish_time i64, prev_publish_time i64, ema_price
///                  i64, ema_conf u64
///   posted_slot: u64
pub fn read_price(
    account: &AccountInfo,
    expected_feed_id: &[u8; 32],
    now_unix: i64,
) -> Result<OraclePrice> {
    require!(account.owner == &PYTH_RECEIVER_ID, PocketError::BadOracle);
    let data = account.try_borrow_data()?;
    require!(data.len() >= MIN_LEN, PocketError::BadOracle);
    require!(data[..8] == PRICE_UPDATE_V2_DISC, PocketError::BadOracle);

    let mut off = 8 + 32;
    // Verification level: demand Full (tag 1). Partial updates carry a
    // num_signatures byte and are refused outright.
    let level = data[off];
    off += 1;
    require!(level == 1, PocketError::BadOracle);

    require!(data.len() >= off + 32 + 8 + 8 + 4 + 8, PocketError::BadOracle);
    let feed_id: [u8; 32] = data[off..off + 32].try_into().unwrap();
    off += 32;
    require!(&feed_id == expected_feed_id, PocketError::BadOracle);

    let price = i64::from_le_bytes(data[off..off + 8].try_into().unwrap());
    off += 8;
    let _conf = u64::from_le_bytes(data[off..off + 8].try_into().unwrap());
    off += 8;
    let exponent = i32::from_le_bytes(data[off..off + 4].try_into().unwrap());
    off += 4;
    let publish_time = i64::from_le_bytes(data[off..off + 8].try_into().unwrap());

    require!(price > 0, PocketError::BadOracle);
    require!(
        publish_time >= now_unix.saturating_sub(MAX_ORACLE_AGE_SECS),
        PocketError::StaleOracle
    );

    Ok(OraclePrice { price, exponent })
}

/// USD value (micro-dollars) of `amount` raw units of a mint with
/// `decimals`, at `price * 10^exponent` dollars per whole token.
/// usd_e6 = amount * price * 10^(6 + exponent) / 10^decimals.
pub fn usd_e6(amount: u64, decimals: u8, p: &OraclePrice) -> Result<u64> {
    // Account metadata can contain the full i32 exponent/u8 decimals
    // ranges. Reject unsupported powers instead of wrapping or panicking.
    let scale = 6i64 + p.exponent as i64 - decimals as i64;
    require!(p.price > 0 && (-38..=38).contains(&scale), PocketError::BadOracle);
    let base = (amount as u128)
        .checked_mul(p.price as u128)
        .ok_or(error!(PocketError::Overflow))?;
    let value = if scale >= 0 {
        base.checked_mul(10u128.pow(scale as u32))
            .ok_or(error!(PocketError::Overflow))?
    } else {
        base / 10u128.pow((-scale) as u32)
    };
    u64::try_from(value).map_err(|_| error!(PocketError::Overflow))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn usd_valuation() {
        // 25 USDC (6 decimals) at $1.00 (price 100000000, expo -8):
        let p = OraclePrice { price: 100_000_000, exponent: -8 };
        assert_eq!(usd_e6(25_000_000, 6, &p).unwrap(), 25_000_000);
        // 0.16 SOL (9 decimals) at $156.25 (price 15625000000, expo -8):
        let p = OraclePrice { price: 15_625_000_000, exponent: -8 };
        assert_eq!(usd_e6(160_000_000, 9, &p).unwrap(), 25_000_000);
    }

    #[test]
    fn unsupported_scales_return_errors_without_panicking() {
        for (exponent, decimals) in [(i32::MAX, 0), (i32::MIN, 255), (-8, 255), (33, 0)] {
            assert!(usd_e6(1, decimals, &OraclePrice { price: 1, exponent }).is_err());
        }
        assert!(usd_e6(u64::MAX, 0, &OraclePrice { price: i64::MAX, exponent: 32 }).is_err());
    }
}
