//! Signature-precompile introspection for session signatures.
//!
//! The pocket never takes the session key as a transaction signer; the
//! solver's transaction carries an Ed25519 or secp256r1 precompile
//! instruction immediately before the pocket instruction, and this module
//! checks — byte for byte — that the precompile verified the pocket's
//! current session key over exactly the expected message. Checking
//! program id, key bytes and message bytes (not merely that a precompile
//! exists) is the fake-precompile control in the threat model.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::Instruction;
use solana_sha256_hasher::hashv;

use crate::state::{PocketError, SESSION_KIND_ED25519, SESSION_KIND_P256};

pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");
pub const SECP256R1_PROGRAM_ID: Pubkey = pubkey!("Secp256r1SigVerify1111111111111111111111111");

/// WebAuthn companion data for P-256 (passkey) session signatures: the
/// precompile message is `authenticator_data || SHA-256(client_data_json)`
/// and the challenge inside clientDataJSON must be the expected hash.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct WebauthnData {
    pub authenticator_data: Vec<u8>,
    pub client_data_json: Vec<u8>,
}

/// Parsed offsets of the (identical) Ed25519 / secp256r1 payload layout:
/// count u8, padding u8, then sig_off u16, sig_ix u16, pk_off u16,
/// pk_ix u16, msg_off u16, msg_len u16, msg_ix u16.
struct SigOffsets {
    sig_ix: u16,
    pk_off: usize,
    pk_ix: u16,
    msg_off: usize,
    msg_len: usize,
    msg_ix: u16,
}

fn parse_single_sig(data: &[u8]) -> Result<SigOffsets> {
    require!(data.len() >= 2 + 14, PocketError::BadSignatureInstruction);
    require!(data[0] == 1, PocketError::BadSignatureInstruction);
    let u16at = |i: usize| -> u16 { u16::from_le_bytes([data[i], data[i + 1]]) };
    Ok(SigOffsets {
        sig_ix: u16at(4),
        pk_off: u16at(6) as usize,
        pk_ix: u16at(8),
        msg_off: u16at(10) as usize,
        msg_len: u16at(12) as usize,
        msg_ix: u16at(14),
    })
}

fn check_refs(o: &SigOffsets, own_index: u16) -> Result<()> {
    for r in [o.sig_ix, o.pk_ix, o.msg_ix] {
        require!(
            r == u16::MAX || r == own_index,
            PocketError::BadSignatureInstruction
        );
    }
    Ok(())
}

/// Verifies that `pre` (the instruction at `pre_index`) is the right
/// precompile for `session_kind`, verified `session_key` over
/// `expected_message` (Ed25519), or over `authenticator_data ||
/// SHA-256(client_data_json)` whose challenge is `expected_message`
/// (P-256 / WebAuthn).
pub fn check_session_signature(
    pre: &Instruction,
    pre_index: u16,
    session_kind: u8,
    session_key: &[u8; 33],
    expected_message: &[u8],
    webauthn: Option<&WebauthnData>,
) -> Result<()> {
    match session_kind {
        SESSION_KIND_ED25519 => {
            require!(
                pre.program_id == ED25519_PROGRAM_ID,
                PocketError::MissingSignature
            );
            let o = parse_single_sig(&pre.data)?;
            check_refs(&o, pre_index)?;
            require!(
                o.pk_off + 32 <= pre.data.len() && o.msg_off + o.msg_len <= pre.data.len(),
                PocketError::BadSignatureInstruction
            );
            require!(
                &pre.data[o.pk_off..o.pk_off + 32] == &session_key[..32],
                PocketError::WrongSigner
            );
            require!(
                &pre.data[o.msg_off..o.msg_off + o.msg_len] == expected_message,
                PocketError::WrongMessage
            );
            Ok(())
        }
        SESSION_KIND_P256 => {
            require!(
                pre.program_id == SECP256R1_PROGRAM_ID,
                PocketError::MissingSignature
            );
            let w = webauthn.ok_or(error!(PocketError::BadWebauthn))?;
            let o = parse_single_sig(&pre.data)?;
            check_refs(&o, pre_index)?;
            require!(
                o.pk_off + 33 <= pre.data.len() && o.msg_off + o.msg_len <= pre.data.len(),
                PocketError::BadSignatureInstruction
            );
            require!(
                &pre.data[o.pk_off..o.pk_off + 33] == session_key.as_slice(),
                PocketError::WrongSigner
            );
            // Expected precompile message: authData || SHA-256(clientDataJSON).
            let cdj_hash = hashv(&[&w.client_data_json]).to_bytes();
            let msg = &pre.data[o.msg_off..o.msg_off + o.msg_len];
            require!(
                msg.len() == w.authenticator_data.len() + 32
                    && &msg[..w.authenticator_data.len()] == w.authenticator_data.as_slice()
                    && &msg[w.authenticator_data.len()..] == cdj_hash.as_slice(),
                PocketError::WrongMessage
            );
            check_webauthn(w, expected_message)
        }
        _ => err!(PocketError::BadSessionKey),
    }
}

/// Minimal WebAuthn assertion checks: authenticator data carries BOTH the
/// user-presence and user-verification flags (a passkey unlocked with
/// biometric/PIN, which is what "passkey-held" promises in the policy
/// rules), and clientDataJSON is a webauthn.get with a challenge equal to
/// `expected_challenge` (base64url, no padding).
fn check_webauthn(w: &WebauthnData, expected_challenge: &[u8]) -> Result<()> {
    require!(w.authenticator_data.len() >= 37, PocketError::BadWebauthn);
    require!(w.authenticator_data[32] & 0x05 == 0x05, PocketError::BadWebauthn);

    let json = &w.client_data_json;
    require!(
        find(json, br#""type":"webauthn.get""#).is_some(),
        PocketError::BadWebauthn
    );
    let tag = br#""challenge":""#;
    let start = find(json, tag).ok_or(error!(PocketError::BadWebauthn))? + tag.len();
    let end = start
        + json[start..]
            .iter()
            .position(|&b| b == b'"')
            .ok_or(error!(PocketError::BadWebauthn))?;
    let challenge =
        base64url_decode(&json[start..end]).ok_or(error!(PocketError::BadWebauthn))?;
    require!(
        challenge.as_slice() == expected_challenge,
        PocketError::BadWebauthn
    );
    Ok(())
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|w| w == needle)
}

fn base64url_decode(input: &[u8]) -> Option<Vec<u8>> {
    fn val(b: u8) -> Option<u32> {
        match b {
            b'A'..=b'Z' => Some((b - b'A') as u32),
            b'a'..=b'z' => Some((b - b'a' + 26) as u32),
            b'0'..=b'9' => Some((b - b'0' + 52) as u32),
            b'-' => Some(62),
            b'_' => Some(63),
            _ => None,
        }
    }
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut chunk = input.chunks_exact(4);
    for c in &mut chunk {
        let n = (val(c[0])? << 18) | (val(c[1])? << 12) | (val(c[2])? << 6) | val(c[3])?;
        out.extend_from_slice(&[(n >> 16) as u8, (n >> 8) as u8, n as u8]);
    }
    match chunk.remainder() {
        [] => {}
        [a, b] => {
            let n = (val(*a)? << 6) | val(*b)?;
            out.push((n >> 4) as u8);
        }
        [a, b, c] => {
            let n = (val(*a)? << 12) | (val(*b)? << 6) | val(*c)?;
            out.extend_from_slice(&[(n >> 10) as u8, (n >> 2) as u8]);
        }
        _ => return None,
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_roundtrip() {
        // "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA" = bytes 1..=32
        let encoded = b"AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA";
        let decoded = base64url_decode(encoded).unwrap();
        let expected: Vec<u8> = (1u8..=32).collect();
        assert_eq!(decoded, expected);
    }

    #[test]
    fn finds_compact_json_fields() {
        let json = br#"{"type":"webauthn.get","challenge":"AQID","origin":"https://ghostlink.dev"}"#;
        assert!(find(json, br#""type":"webauthn.get""#).is_some());
        let tag = br#""challenge":""#;
        let start = find(json, tag).unwrap() + tag.len();
        let end = start + json[start..].iter().position(|&b| b == b'"').unwrap();
        assert_eq!(base64url_decode(&json[start..end]).unwrap(), vec![1, 2, 3]);
    }
}
