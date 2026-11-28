#![no_std]
//! PayOnce `payable_registry_v3` — Verification of Payee (VoP) for AI agents.
//! Concordium Trusted Agents hackathon, TESTNET ONLY.
//!
//! v3 = v2.1 + a PAYEE BOOK. EU Regulation (EU) 2024/886 makes euro banks
//! check the payee's name against the account before a transfer. v3 gives
//! agent payments the on-chain half of that check:
//!
//!   1. `propose_payee` (sent by the SELLER, whose CIS-8004 agent must be
//!      Active and owned by it) names a payee account together with the
//!      payee's identity anchor: the identity-provider index, sha256 of the
//!      normalised legal name, the ISO country, and `proof_anchor` = sha256
//!      of the Concordium V&A verifiable presentation / audit record that
//!      reveals that legal name + country (verified off chain, keylessly,
//!      by PayOnce `check_payee` against the node).
//!   2. `accept_payee` must be sent BY THE PAYEE ACCOUNT ITSELF and must
//!      repeat the exact `proof_anchor` and record version. So the payee's
//!      own signature covers the identity anchor: a seller cannot bind an
//!      account that did not agree, and cannot swap the anchor after the
//!      payee signed (-33).
//!   3. Binding starts a chain-enforced COOLING-OFF (`cooling_off_secs`,
//!      set at init). Any later change to a payee's details (re-propose)
//!      bumps the version, puts the payee back to Proposed and restarts the
//!      cooling-off. Payables registered against an older version can no
//!      longer be paid (-31 PayeeChanged): "our bank details changed" can't
//!      silently redirect money that is already invoiced.
//!   4. `acknowledge_payee`: each BUYER acknowledges a payee version once,
//!      recording the VoP verdict (Match / Close match) and the sha256 of
//!      the `check_payee` evidence on chain. The contract refuses to record
//!      an acknowledgment for No match / Unverified (-36).
//!   5. `pay_ccd` and `reserve_plt` additionally require: payee Bound (-28),
//!      same version as at registration (-31), cooling-off over (-29), and
//!      this buyer's acknowledgment of this version (-30).
//!
//! Everything v2.1 enforced is kept unchanged: pay exactly once (-5/-16),
//! exact amount (-6), the CIS-8004 `agentOf` cross-call (-8/-9/-10/-11),
//! the buyer's vendor list / strict mode (-19), caps (-23), expected payer
//! (-21), and `pay_ccd` forwards in the same transaction, so the contract
//! holds no balance across transactions. Reject codes -1..-27 are frozen as
//! in v2.1; v3 APPENDS -28..-36 (declaration order = code table).
//!
//! HONEST BOUNDARY: a contract cannot verify a ZK presentation. The chain
//! enforces WHO signed (seller + payee), WHEN (cooling-off), WHO accepted
//! the risk (buyer acknowledgment) and WHAT was anchored (hashes). That the
//! anchored presentation is valid, belongs to the payee account's credential
//! and reveals the claimed legal name is checked by `check_payee`, which
//! anyone can re-run without keys.
//!
//! ---- v2.1 notes (unchanged behaviour) ----
//! PayOnce `payable_registry_v3` — Concordium Trusted Agents hackathon.
//!
//! v2.1 = v2 + exactly two changes (see CONTRACT_V21_REPORT.md):
//!   (1) F1: the `-18` stray-balance griefing fix. v2 asserted
//!       `self_balance() == 0` after the `pay_ccd` forward, so a direct
//!       dust donation to the contract bricked every later `pay_ccd` (and
//!       the dust was stuck — no sweep entrypoint, D10). v2.1 asserts the
//!       call forwarded exactly the attached amount instead: the balance
//!       after the forward equals the balance observed at entry minus the
//!       forwarded amount. A pre-existing stray balance is tolerated; the
//!       call neither creates nor loses CCD.
//!   (2) F5: `record_payment_tx` — the payer records the `pay_ccd`
//!       transaction hash after finalization, so the view pins the CCD
//!       payment tx (v2 stored `tx_hash: None` on the CCD path).
//!       PLATFORM LIMIT, stated plainly: a Concordium contract cannot
//!       observe its own transaction hash (the tx hash is sha256 over the
//!       serialization INCLUDING the signatures — see
//!       `@concordium/web-sdk` `getAccountTransactionHash` — so the payer
//!       cannot know it before signing, and concordium-std exposes no
//!       tx-hash accessor). The hash is therefore caller-supplied, exactly
//!       like `confirm_plt`'s hash on the PLT path, and it is evidence
//!       only (like `doc_hash`): the verifier MUST check it resolves to
//!       the `pay_ccd` transaction for this payable, and a wrong hash fails
//!       receipt verification. The contract never uses it for a money
//!       decision, and only the recorded payer may set it, once.
//! (payee, amount, asset, due date, seller CIS-8004 token, `doc_hash` as
//! evidence only) that can be paid exactly once, only to the account the
//! seller put on chain.
//!
//! Rail A (CCD): `pay_ccd` IS the payment — it checks Unpaid + exact amount +
//! seller agent Active, sets Paid, and forwards the full amount to the stored
//! payee in ONE atomic transaction. Contract balance is zero before and after.
//!
//! Rail B (PLT, e.g. EUDemo): the guard PRECEDES the payment. The expected
//! payer calls `reserve_plt` (contract marks Reserved{payer, expiry}; a second
//! reservation reverts on chain); the co-signer co-signs only a transfer to the
//! stored payee, of the stored amount, with memo `payable:<seller>:<id>`,
//! while Reserved; `confirm_plt(id, tx)` sets Paid and rejects tx-hash reuse.
//! Contracts cannot see or move PLTs, so the euro rail rests on the co-signer
//! + the reservation, not on the contract alone. That is the honest boundary.
//!
//! H1 (owner-approved vendors): a buyer approves sellers on chain
//! (`approve_vendor`) with a tier, an optional `legal_ref` (sha256 of the
//! company-identity VAA record, verified off chain by the verifier), a
//! per-payable cap and a period cap. `reserve_plt` always requires an
//! approval; `pay_ccd` requires one only in strict mode.
//!
//! H2 (junk confirm): the seller names the `expected_payer` at registration;
//! only that account can reserve or confirm; the seller can no longer confirm.
//! `confirm_plt` is allowed only while `now <= expires` (the reservation
//! race fix, R-a). The seller recognises payment through the verifier, never
//! through the `status` field.
//!
//! Reject codes are FROZEN as plan P1 §1.4 (-1..-27, in declaration order —
//! the `Reject` derive maps the first variant to -1, second to -2, etc.).
//! There is deliberately NO `ParseError` variant: parameter parse failures
//! map to `Invalid` (-14) and cross-call response parse failures map to
//! `RegistryCallFailed` (-11), so the 27 codes in the plan stay exact.
//!
//! Wording (doctrine): the contract "holds no balance across transactions;
//! each payment is forwarded in the same transaction". Never "escrow",
//! "vault" or "holds funds".
//!
//! Testnet only. No mainnet, ever.

use concordium_std::*;

/// Official CIS-8004 agent registry on testnet (passed at init as `cis8004`;
/// the constant below is only the default used by deploy scripts).
pub const REGISTRY_TESTNET: ContractAddress = ContractAddress {
    index: 12802,
    subindex: 0,
};

/// Maximum reservation window: 7 days, as v1.
pub const RESERVATION_MAX_SECS: u64 = 7 * 24 * 3600;

/// Cooling-off bounds (init): at least 60 s, at most 30 days.
pub const COOLING_OFF_MIN_SECS: u64 = 60;
pub const COOLING_OFF_MAX_SECS: u64 = 30 * 24 * 3600;

/// VoP verdicts a buyer may acknowledge (EPC VoP vocabulary).
pub const VERDICT_MATCH: u8 = 0;
pub const VERDICT_CLOSE_MATCH: u8 = 1;
pub const VERDICT_NO_MATCH: u8 = 2;
pub const VERDICT_UNVERIFIED: u8 = 3;

/// `schema_version` carried by every event.
pub const SCHEMA_VERSION: u8 = 4;

/// Reject codes, FROZEN per plan P1 §1.4. Declaration order IS the code
/// table: variant 0 -> -1, variant 1 -> -2, ..., variant 26 -> -27.
/// Do NOT reorder, insert, or remove variants without freezing a new table
/// and recording it in the deploy log.
#[derive(Debug, PartialEq, Eq, Reject, Serial, Deserial, SchemaType)]
pub enum ContractError {
    /// -1: sender is a contract (every mutating entrypoint requires an account).
    Unauthorized,
    /// -2: `register_payable` for a key `(seller, payable_id)` that exists.
    Duplicate,
    /// -3: load of a missing payable / vendor row / usage key.
    NotFound,
    /// -4: entrypoint called on a payable of the wrong asset.
    WrongAsset,
    /// -5: entrypoint called in the wrong status.
    WrongStatus,
    /// -6: attached CCD != stored amount (`pay_ccd`).
    WrongAmount,
    /// -7: `due` is in the past, or the call is after `due`.
    PastDue,
    /// -8: CIS-8004 `agentOf` returned None (no such agent).
    AgentNotFound,
    /// -9: agent exists but its status is not Active.
    AgentRevoked,
    /// -10: agent's `owner_account` != seller.
    AgentOwnerMismatch,
    /// -11: the CIS-8004 cross-call failed or its response did not parse.
    RegistryCallFailed,
    /// -12: `confirm_plt` with an already-used tx hash.
    TxReused,
    /// -13: `expire_reservation` while `now <= expires`.
    NotExpired,
    /// -14: malformed parameter, zero amount, zero doc_hash, zero agent
    /// token, bad PLT symbol length, zero hash on confirm, bad caps/period.
    Invalid,
    /// -15: `invoke_transfer` in `pay_ccd` failed.
    TransferFailed,
    /// -16: `reserve_plt` on a payable that is not Unpaid.
    NotUnpaid,
    /// -17: `confirm_plt` by an account other than the reserving payer.
    NotPayer,
    /// -18: `pay_ccd` did not forward exactly the attached amount
    /// (v2.1: post-forward balance + amount != balance observed at entry).
    /// v2 asserted a zero balance here; v2.1 tolerates a pre-existing
    /// stray balance (F1).
    Invariant,
    /// -19: no vendor approval row for (buyer, seller).
    NotApprovedVendor,
    /// -20: payable `legal_ref` != approval `legal_ref`.
    LegalRefMismatch,
    /// -21: caller is not the `expected_payer`.
    NotExpectedPayer,
    /// -22: PLT payable registered without `expected_payer`.
    ExpectedPayerRequired,
    /// -23: per-payable cap or period cap exceeded.
    CapExceeded,
    /// -24: `confirm_plt` after the reservation window (`now > expires`).
    ConfirmAfterWindow,
    /// -25: `pay_ccd` / `reserve_plt` on a Voided payable.
    Voided,
    /// -26: `void_payable` on a Reserved payable inside its window.
    VoidWhileReserved,
    /// -27: self-action (payer == seller, approver == seller,
    /// `expected_payer` == seller).
    SelfAction,
    // ---- v3 (Verification of Payee), appended; -1..-27 unchanged ----
    /// -28: the payee is not Bound in the seller's payee book (never
    /// proposed, still waiting for the payee's own acceptance, or revoked).
    PayeeNotBound,
    /// -29: the payee's cooling-off period has not ended yet.
    PayeeNotMature,
    /// -30: this buyer has not acknowledged this payee version.
    PayeeNotAcknowledged,
    /// -31: the payee's details changed after the payable was registered.
    PayeeChanged,
    /// -32: `accept_payee` without a pending proposal for (seller, sender).
    PayeeNotProposed,
    /// -33: `accept_payee` with a proof anchor other than the proposed one.
    AnchorMismatch,
    /// -34: the version named by the caller is not the record's version.
    PayeeVersionMismatch,
    /// -35: `revoke_payee` by an account that is neither seller nor payee.
    NotPayeeParty,
    /// -36: `acknowledge_payee` with a verdict other than Match/Close match.
    VerdictNotPayable,
}

pub type ContractResult<A> = Result<A, ContractError>;

/// Asset of a payable. Amounts are minor units: microCCD for CCD, token
/// minor units for a PLT (EUDemo: 6 decimals, so 1.00 EUDemo = 1_000_000).
#[derive(Debug, Clone, PartialEq, Eq, Serial, Deserial, SchemaType)]
pub enum Asset {
    Ccd,
    Plt(String),
}

/// Lifecycle of a payable. `Paid` keeps `reservation_expires` so the
/// verifier can check the transfer's block time against the window (F11).
#[derive(Debug, Clone, Serial, Deserial, SchemaType)]
pub enum Status {
    Unpaid,
    Reserved {
        payer: AccountAddress,
        reserved_at: Timestamp,
        expires: Timestamp,
    },
    Paid {
        payer: AccountAddress,
        reservation_expires: Option<Timestamp>,
        paid_at: Timestamp,
        tx_hash: Option<[u8; 32]>,
    },
    Voided {
        at: Timestamp,
    },
}

#[derive(Debug, Clone, Serial, Deserial, SchemaType)]
pub struct Payable {
    pub seller: AccountAddress,
    pub payable_id: u64,
    pub payee: AccountAddress,
    /// Minor units of `asset` (microCCD for CCD).
    pub amount: u64,
    pub asset: Asset,
    pub due: Timestamp,
    pub doc_hash: [u8; 32],
    pub agent_token: u64,
    pub expected_payer: Option<AccountAddress>,
    /// sha256 of the company-identity VAA record (verified off chain).
    pub legal_ref: Option<[u8; 32]>,
    /// v3: the payee-book version the payable was registered against.
    pub payee_version: u32,
    pub status: Status,
}

/// v3: the payee's identity anchor. The chain stores it; `check_payee`
/// verifies it (presentation valid with the node, credential belongs to the
/// payee account, revealed legal name/country hash to these values).
#[derive(Debug, Clone, PartialEq, Eq, Serial, Deserial, SchemaType)]
pub struct PayeeIdentity {
    /// 1 = business identity (Global FinReg), 2 = person identity.
    /// Declared by the seller, confirmed off chain from the credential's
    /// identity provider.
    pub kind: u8,
    /// Identity-provider index of the presenting credential (Global
    /// FinReg: 4 on testnet, 3 on mainnet — never hard-code across nets).
    pub idp_index: u32,
    /// sha256 of the normalised legal name revealed by the proof.
    pub legal_name_hash: [u8; 32],
    /// ISO 3166-1 alpha-2 country, ASCII upper case.
    pub country: [u8; 2],
    /// sha256 of the V&A presentation / audit record carrying the proof.
    pub proof_anchor: [u8; 32],
    /// Optional registerData transaction anchoring that record (evidence).
    pub anchor_tx: Option<[u8; 32]>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serial, Deserial, SchemaType)]
pub enum PayeeStatus {
    /// Proposed by the seller, waiting for the payee account's acceptance.
    Proposed,
    /// Accepted by the payee account; payable after `mature_at`.
    Bound,
    /// Revoked by the seller or the payee.
    Revoked,
}

#[derive(Debug, Clone, PartialEq, Eq, Serial, Deserial, SchemaType)]
pub struct PayeeRecord {
    pub seller: AccountAddress,
    pub payee: AccountAddress,
    pub identity: PayeeIdentity,
    pub status: PayeeStatus,
    /// Starts at 1 and increments on every change (re-propose, revoke).
    pub version: u32,
    pub proposed_at: Timestamp,
    pub bound_at: Option<Timestamp>,
    /// End of the cooling-off: `bound_at + cooling_off_secs`.
    pub mature_at: Option<Timestamp>,
}

/// v3: one buyer's acknowledgment of one payee version.
#[derive(Debug, Clone, PartialEq, Eq, Serial, Deserial, SchemaType)]
pub struct PayeeAck {
    pub version: u32,
    /// VoP verdict the buyer relied on (0 Match, 1 Close match).
    pub verdict: u8,
    /// sha256 of the `check_payee` evidence JSON the buyer relied on.
    pub evidence_hash: [u8; 32],
    pub at: Timestamp,
}

/// One buyer-approved vendor row. `tier` is the buyer's own assessment
/// (0 agent only, 1 person identity, 2 company identity). The chain stores
/// it and does not verify it.
#[derive(Debug, Clone, PartialEq, Eq, Serial, Deserial, SchemaType)]
pub struct VendorApproval {
    pub tier: u8,
    pub legal_ref: Option<[u8; 32]>,
    /// Max minor units per single payable.
    pub per_payable_cap: u64,
    /// Max minor units per (buyer, seller, period).
    pub period_cap: u64,
    pub period_secs: u64,
}

#[derive(Debug, Clone, Copy, Serial, Deserial, SchemaType)]
pub struct BuyerPolicy {
    pub strict: bool,
}

#[derive(Debug, Clone, Copy, Serial, Deserial, SchemaType)]
pub struct Config {
    pub cis8004: ContractAddress,
    pub reservation_secs: u64,
    /// v3: payee cooling-off after binding or any change.
    pub cooling_off_secs: u64,
}

#[derive(Serial, DeserialWithState, Deletable)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    config: Config,
    payables: StateMap<(AccountAddress, u64), Payable, S>,
    used_tx: StateSet<[u8; 32], S>,
    vendors: StateMap<(AccountAddress, AccountAddress), VendorApproval, S>,
    buyer_policy: StateMap<AccountAddress, BuyerPolicy, S>,
    usage: StateMap<(AccountAddress, AccountAddress, u64), u64, S>,
    /// v3 payee book: (seller, payee) -> record.
    payees: StateMap<(AccountAddress, AccountAddress), PayeeRecord, S>,
    /// v3 acknowledgments: (buyer, seller, payee) -> ack.
    acks: StateMap<(AccountAddress, AccountAddress, AccountAddress), PayeeAck, S>,
}

/// Events. Every event carries `schema_version: 3` and is keyed by
/// `(seller, payable_id)` so indexers can follow one payable.
#[derive(Debug, Serial, Deserial, SchemaType)]
pub enum ContractEvent {
    Registered {
        schema_version: u8,
        seller: AccountAddress,
        payable_id: u64,
        payee: AccountAddress,
        amount: u64,
        asset: Asset,
        due: Timestamp,
        doc_hash: [u8; 32],
        expected_payer: Option<AccountAddress>,
        legal_ref: Option<[u8; 32]>,
        payee_version: u32,
    },
    VendorApproved {
        schema_version: u8,
        buyer: AccountAddress,
        seller: AccountAddress,
        tier: u8,
        legal_ref: Option<[u8; 32]>,
        per_payable_cap: u64,
        period_cap: u64,
        period_secs: u64,
    },
    VendorRevoked {
        schema_version: u8,
        buyer: AccountAddress,
        seller: AccountAddress,
    },
    StrictSet {
        schema_version: u8,
        buyer: AccountAddress,
        strict: bool,
    },
    Reserved {
        schema_version: u8,
        seller: AccountAddress,
        payable_id: u64,
        payer: AccountAddress,
        expires: Timestamp,
    },
    Released {
        schema_version: u8,
        seller: AccountAddress,
        payable_id: u64,
    },
    Paid {
        schema_version: u8,
        seller: AccountAddress,
        payable_id: u64,
        payer: AccountAddress,
        amount: u64,
        asset: Asset,
    },
    PltConfirmed {
        schema_version: u8,
        seller: AccountAddress,
        payable_id: u64,
        payer: AccountAddress,
        tx_hash: [u8; 32],
        reservation_expires: Timestamp,
    },
    Voided {
        schema_version: u8,
        seller: AccountAddress,
        payable_id: u64,
    },
    /// v2.1 (F5): the payer recorded the `pay_ccd` transaction hash.
    PaymentTxRecorded {
        schema_version: u8,
        seller: AccountAddress,
        payable_id: u64,
        payer: AccountAddress,
        tx_hash: [u8; 32],
    },
    /// v3: the seller proposed (or changed) a payee.
    PayeeProposed {
        schema_version: u8,
        seller: AccountAddress,
        payee: AccountAddress,
        version: u32,
        identity: PayeeIdentity,
    },
    /// v3: the payee account accepted; payable from `mature_at`.
    PayeeBound {
        schema_version: u8,
        seller: AccountAddress,
        payee: AccountAddress,
        version: u32,
        proof_anchor: [u8; 32],
        mature_at: Timestamp,
    },
    /// v3: seller or payee revoked the binding.
    PayeeRevoked {
        schema_version: u8,
        seller: AccountAddress,
        payee: AccountAddress,
        version: u32,
        by: AccountAddress,
    },
    /// v3: a buyer acknowledged a payee version with a VoP verdict.
    PayeeAcknowledged {
        schema_version: u8,
        buyer: AccountAddress,
        seller: AccountAddress,
        payee: AccountAddress,
        version: u32,
        verdict: u8,
        evidence_hash: [u8; 32],
    },
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct InitParam {
    pub cis8004: ContractAddress,
    pub reservation_secs: u64,
    pub cooling_off_secs: u64,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct RegisterPayableParam {
    pub payable_id: u64,
    pub payee: AccountAddress,
    pub amount: u64,
    pub asset: Asset,
    pub due: Timestamp,
    pub doc_hash: [u8; 32],
    pub agent_token: u64,
    pub expected_payer: Option<AccountAddress>,
    pub legal_ref: Option<[u8; 32]>,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct ApproveVendorParam {
    pub seller: AccountAddress,
    pub tier: u8,
    pub legal_ref: Option<[u8; 32]>,
    pub per_payable_cap: u64,
    pub period_cap: u64,
    pub period_secs: u64,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct RevokeVendorParam {
    pub seller: AccountAddress,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct SetStrictParam {
    pub strict: bool,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct PayableKeyParam {
    pub seller: AccountAddress,
    pub payable_id: u64,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct ConfirmPltParam {
    pub seller: AccountAddress,
    pub payable_id: u64,
    pub tx_hash: [u8; 32],
}

/// v2.1 (F5): the payer records the `pay_ccd` transaction hash after the
/// payment finalizes. The hash is caller-supplied and evidence only — the
/// contract cannot observe its own tx hash (see the module docs), so the
/// verifier must check it resolves to the `pay_ccd` transaction for this
/// payable.
#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct RecordPaymentTxParam {
    pub seller: AccountAddress,
    pub payable_id: u64,
    pub tx_hash: [u8; 32],
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct VoidPayableParam {
    pub payable_id: u64,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct GetVendorParam {
    pub buyer: AccountAddress,
    pub seller: AccountAddress,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct GetUsageParam {
    pub buyer: AccountAddress,
    pub seller: AccountAddress,
    pub period_index: u64,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct GetBuyerPolicyParam {
    pub buyer: AccountAddress,
}

/// v3: sent by the seller.
#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct ProposePayeeParam {
    pub payee: AccountAddress,
    pub agent_token: u64,
    pub identity: PayeeIdentity,
}

/// v3: sent by the payee account itself.
#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct AcceptPayeeParam {
    pub seller: AccountAddress,
    pub version: u32,
    pub proof_anchor: [u8; 32],
}

/// v3: (seller, payee) key, for `revoke_payee` and `get_payee`.
#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct PayeeRefParam {
    pub seller: AccountAddress,
    pub payee: AccountAddress,
}

/// v3: sent by the buyer.
#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct AcknowledgePayeeParam {
    pub seller: AccountAddress,
    pub payee: AccountAddress,
    pub version: u32,
    pub verdict: u8,
    pub evidence_hash: [u8; 32],
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct GetAckParam {
    pub buyer: AccountAddress,
    pub seller: AccountAddress,
    pub payee: AccountAddress,
}

#[init(contract = "payable_registry_v3", parameter = "InitParam", error = "ContractError")]
fn contract_init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let param: InitParam = ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    ensure!(
        param.reservation_secs > 0 && param.reservation_secs <= RESERVATION_MAX_SECS,
        Reject::from(ContractError::Invalid)
    );
    ensure!(
        param.cooling_off_secs >= COOLING_OFF_MIN_SECS
            && param.cooling_off_secs <= COOLING_OFF_MAX_SECS,
        Reject::from(ContractError::Invalid)
    );
    Ok(State {
        config: Config {
            cis8004: param.cis8004,
            reservation_secs: param.reservation_secs,
            cooling_off_secs: param.cooling_off_secs,
        },
        payables: state_builder.new_map(),
        used_tx: state_builder.new_set(),
        vendors: state_builder.new_map(),
        buyer_policy: state_builder.new_map(),
        usage: state_builder.new_map(),
        payees: state_builder.new_map(),
        acks: state_builder.new_map(),
    })
}

/// Mutating entrypoints accept accounts only. A contract sender is never a
/// buyer, seller or payer.
fn ensure_account_sender(ctx: &ReceiveContext) -> ContractResult<AccountAddress> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(ContractError::Unauthorized),
    }
}

fn slot_time_millis(ctx: &ReceiveContext) -> u64 {
    ctx.metadata().slot_time().timestamp_millis()
}

/// Minimal allocation-free reader over the `agentOf` return bytes.
/// Layout (proven live against `<12802,0>` by the merge-round spike):
/// flag byte, token id (0x08 + u64 LE), owner (32 bytes),
/// agent_uri (Option<String>), metadata_hash (Option<[u8;32]>),
/// external_reference (Option<ExtRef>), agent_wallet (Option<AccountAddress>),
/// status (u8: 0 = Active, 1 = Revoked).
struct Reader<'a> {
    bytes: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn u8(&mut self) -> ContractResult<u8> {
        let b = *self.bytes.get(self.pos).ok_or(ContractError::RegistryCallFailed)?;
        self.pos += 1;
        Ok(b)
    }

    fn take(&mut self, n: usize) -> ContractResult<&'a [u8]> {
        let end = self.pos.checked_add(n).ok_or(ContractError::RegistryCallFailed)?;
        let s = self.bytes.get(self.pos..end).ok_or(ContractError::RegistryCallFailed)?;
        self.pos = end;
        Ok(s)
    }

    fn u32_le(&mut self) -> ContractResult<u32> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn skip_string(&mut self) -> ContractResult<()> {
        let len = self.u32_le()? as usize;
        self.take(len)?;
        Ok(())
    }

    fn skip_optional_string(&mut self) -> ContractResult<()> {
        if self.u8()? == 1 {
            let len = self.u32_le()? as usize;
            self.take(len)?;
        }
        Ok(())
    }

    fn skip_optional_hash(&mut self) -> ContractResult<()> {
        if self.u8()? == 1 {
            self.take(32)?;
        }
        Ok(())
    }

    fn skip_optional_ext_ref(&mut self) -> ContractResult<()> {
        if self.u8()? == 1 {
            self.take(16)?; // ContractAddress (index + subindex, u64 LE each)
            let kind = self.u8()?;
            if kind != 0 {
                return Err(ContractError::RegistryCallFailed);
            }
            self.skip_string()?; // namespace
            self.skip_string()?; // key_type
            let len = self.u32_le()? as usize; // public_key Bytestring
            self.take(len)?;
        }
        Ok(())
    }

    fn skip_optional_address(&mut self) -> ContractResult<()> {
        if self.u8()? == 1 {
            self.take(32)?;
        }
        Ok(())
    }
}

/// Parse `agentOf` return bytes into `(owner_account, status_byte)`.
/// `None` (no such agent) maps to `AgentNotFound` (-8); any shape error maps
/// to `RegistryCallFailed` (-11). Status 0 = Active, 1 = Revoked.
fn parse_agent_view(bytes: &[u8]) -> ContractResult<(AccountAddress, u8)> {
    let mut r = Reader { bytes, pos: 0 };
    if r.u8()? == 0 {
        return Err(ContractError::AgentNotFound);
    }
    let _token_id = r.take(9)?; // AgentTokenId: 0x08 + u64 LE
    let owner_bytes = r.take(32)?;
    let mut owner_arr = [0u8; 32];
    owner_arr.copy_from_slice(owner_bytes);
    let owner = AccountAddress(owner_arr);
    r.skip_optional_string()?; // agent_uri
    r.skip_optional_hash()?; // metadata_hash
    r.skip_optional_ext_ref()?; // external_reference
    r.skip_optional_address()?; // agent_wallet
    let status = r.u8()?;
    Ok((owner, status))
}

/// Cross-call `CIS-8004.agentOf` for `token_id`. Any failure fails closed.
fn check_agent_active(
    host: &Host<State>,
    registry: ContractAddress,
    token_id: u64,
) -> ContractResult<(AccountAddress, u8)> {
    let mut param = [0u8; 9];
    param[0] = 8; // AgentTokenId wire form: length byte 8
    param[1..9].copy_from_slice(&token_id.to_le_bytes());
    let response = host
        .invoke_contract_raw_read_only(
            &registry,
            Parameter::new_unchecked(&param),
            EntrypointName::new_unchecked("agentOf"),
            Amount::zero(),
        )
        .map_err(|_| ContractError::RegistryCallFailed)?;
    let mut response = response.ok_or(ContractError::RegistryCallFailed)?;
    let size = response.size() as usize;
    let mut bytes = vec![0u8; size];
    let n = response.read(&mut bytes).map_err(|_| ContractError::RegistryCallFailed)?;
    if n != size {
        return Err(ContractError::RegistryCallFailed);
    }
    parse_agent_view(&bytes)
}

/// The CIS-8004 checks shared by every money-moving entrypoint, in the
/// plan's order: agent exists (-8), Active (-9), owned by the seller (-10).
fn check_seller_agent(
    host: &Host<State>,
    registry: ContractAddress,
    agent_token: u64,
    seller: AccountAddress,
) -> ContractResult<()> {
    let (owner, status) = check_agent_active(host, registry, agent_token)?;
    ensure!(status == 0, ContractError::AgentRevoked);
    ensure!(owner == seller, ContractError::AgentOwnerMismatch);
    Ok(())
}

fn load_payable(
    state: &State,
    seller: AccountAddress,
    payable_id: u64,
) -> ContractResult<Payable> {
    state
        .payables
        .get(&(seller, payable_id))
        .map(|p| (*p).clone())
        .ok_or(ContractError::NotFound)
}

/// Per-payable + period cap check. `usage` is never decremented (D9).
fn check_caps(
    state: &State,
    buyer: AccountAddress,
    seller: AccountAddress,
    approval: &VendorApproval,
    amount: u64,
    now_ms: u64,
) -> ContractResult<()> {
    ensure!(amount <= approval.per_payable_cap, ContractError::CapExceeded);
    let period_index = (now_ms / 1000) / approval.period_secs;
    let used = state.usage.get(&(buyer, seller, period_index)).map(|v| *v).unwrap_or(0);
    ensure!(
        used.saturating_add(amount) <= approval.period_cap,
        ContractError::CapExceeded
    );
    Ok(())
}

fn charge_usage(
    state: &mut State,
    buyer: AccountAddress,
    seller: AccountAddress,
    period_secs: u64,
    amount: u64,
    now_ms: u64,
) {
    let period_index = (now_ms / 1000) / period_secs;
    let used = state.usage.get(&(buyer, seller, period_index)).map(|v| *v).unwrap_or(0);
    let _ = state.usage.insert((buyer, seller, period_index), used.saturating_add(amount));
}

fn check_legal_ref(payable: &Payable, approval: &VendorApproval) -> ContractResult<()> {
    if let Some(legal) = approval.legal_ref {
        ensure!(payable.legal_ref == Some(legal), ContractError::LegalRefMismatch);
    }
    Ok(())
}

/// v3: version of a Bound payee in `seller`'s book, or -28.
fn bound_payee_version(
    state: &State,
    seller: AccountAddress,
    payee: AccountAddress,
) -> ContractResult<u32> {
    let rec = state.payees.get(&(seller, payee)).ok_or(ContractError::PayeeNotBound)?;
    ensure!(rec.status == PayeeStatus::Bound, ContractError::PayeeNotBound);
    Ok(rec.version)
}

/// v3: the payment-time payee checks, in order: Bound (-28), unchanged
/// since registration (-31), cooling-off over (-29), acknowledged by this
/// buyer for this version (-30).
fn check_payee_payable(
    state: &State,
    payable: &Payable,
    buyer: AccountAddress,
    now_ms: u64,
) -> ContractResult<()> {
    let rec = state
        .payees
        .get(&(payable.seller, payable.payee))
        .map(|r| (*r).clone())
        .ok_or(ContractError::PayeeNotBound)?;
    ensure!(rec.status == PayeeStatus::Bound, ContractError::PayeeNotBound);
    ensure!(rec.version == payable.payee_version, ContractError::PayeeChanged);
    let mature_at = rec.mature_at.ok_or(ContractError::PayeeNotMature)?;
    ensure!(now_ms >= mature_at.timestamp_millis(), ContractError::PayeeNotMature);
    let ack = state
        .acks
        .get(&(buyer, payable.seller, payable.payee))
        .map(|a| (*a).clone())
        .ok_or(ContractError::PayeeNotAcknowledged)?;
    ensure!(ack.version == rec.version, ContractError::PayeeNotAcknowledged);
    Ok(())
}

fn valid_identity(id: &PayeeIdentity) -> bool {
    (id.kind == 1 || id.kind == 2)
        && id.legal_name_hash != [0u8; 32]
        && id.proof_anchor != [0u8; 32]
        && id.country[0].is_ascii_uppercase()
        && id.country[1].is_ascii_uppercase()
        && id.anchor_tx != Some([0u8; 32])
}

#[receive(
    contract = "payable_registry_v3",
    name = "register_payable",
    parameter = "RegisterPayableParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_register_payable(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let seller = ensure_account_sender(ctx)?;
    let param: RegisterPayableParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    // Checks in the plan's order (§1.3).
    ensure!(param.amount > 0, ContractError::Invalid);
    ensure!(param.doc_hash != [0u8; 32], ContractError::Invalid);
    // "token 1..255 bytes": the agent token id is a u64; the only range check
    // expressible on it is non-zero. A zero token id is invalid (-14); an
    // unknown non-zero token is caught by the cross-call (-8).
    ensure!(param.agent_token != 0, ContractError::Invalid);
    if let Asset::Plt(symbol) = &param.asset {
        ensure!(!symbol.is_empty() && symbol.len() <= 64, ContractError::Invalid);
        ensure!(param.expected_payer.is_some(), ContractError::ExpectedPayerRequired);
    }
    if let Some(expected) = param.expected_payer {
        ensure!(expected != seller, ContractError::SelfAction);
    }
    ensure!(param.due.timestamp_millis() > now_ms, ContractError::PastDue);
    ensure!(
        host.state().payables.get(&(seller, param.payable_id)).is_none(),
        ContractError::Duplicate
    );
    let registry = host.state().config.cis8004;
    check_seller_agent(host, registry, param.agent_token, seller)?;
    // v3: the payee must be Bound in this seller's payee book (accepted by
    // the payee account itself). Maturity is checked at payment time.
    let payee_version = bound_payee_version(host.state(), seller, param.payee)?;
    let state = host.state_mut();
    let _ = state.payables.insert((seller, param.payable_id), Payable {
        seller,
        payable_id: param.payable_id,
        payee: param.payee,
        amount: param.amount,
        asset: param.asset.clone(),
        due: param.due,
        doc_hash: param.doc_hash,
        agent_token: param.agent_token,
        expected_payer: param.expected_payer,
        legal_ref: param.legal_ref,
        payee_version,
        status: Status::Unpaid,
    });
    logger
        .log(&ContractEvent::Registered {
            schema_version: SCHEMA_VERSION,
            seller,
            payable_id: param.payable_id,
            payee: param.payee,
            amount: param.amount,
            asset: param.asset,
            due: param.due,
            doc_hash: param.doc_hash,
            expected_payer: param.expected_payer,
            legal_ref: param.legal_ref,
            payee_version,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "approve_vendor",
    parameter = "ApproveVendorParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_approve_vendor(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let buyer = ensure_account_sender(ctx)?;
    let param: ApproveVendorParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    ensure!(param.seller != buyer, ContractError::SelfAction);
    ensure!(
        param.per_payable_cap > 0 && param.period_cap > 0 && param.period_secs > 0,
        ContractError::Invalid
    );
    let _ = host.state_mut().vendors.insert((buyer, param.seller), VendorApproval {
        tier: param.tier,
        legal_ref: param.legal_ref,
        per_payable_cap: param.per_payable_cap,
        period_cap: param.period_cap,
        period_secs: param.period_secs,
    });
    logger
        .log(&ContractEvent::VendorApproved {
            schema_version: SCHEMA_VERSION,
            buyer,
            seller: param.seller,
            tier: param.tier,
            legal_ref: param.legal_ref,
            per_payable_cap: param.per_payable_cap,
            period_cap: param.period_cap,
            period_secs: param.period_secs,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "revoke_vendor",
    parameter = "RevokeVendorParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_revoke_vendor(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let buyer = ensure_account_sender(ctx)?;
    let param: RevokeVendorParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    ensure!(
        host.state().vendors.get(&(buyer, param.seller)).is_some(),
        ContractError::NotFound
    );
    host.state_mut().vendors.remove(&(buyer, param.seller));
    logger
        .log(&ContractEvent::VendorRevoked {
            schema_version: SCHEMA_VERSION,
            buyer,
            seller: param.seller,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "set_strict",
    parameter = "SetStrictParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_set_strict(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let buyer = ensure_account_sender(ctx)?;
    let param: SetStrictParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let _ = host.state_mut().buyer_policy.insert(buyer, BuyerPolicy { strict: param.strict });
    logger
        .log(&ContractEvent::StrictSet {
            schema_version: SCHEMA_VERSION,
            buyer,
            strict: param.strict,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "pay_ccd",
    parameter = "PayableKeyParam",
    error = "ContractError",
    payable,
    mutable,
    enable_logger
)]
fn contract_pay_ccd(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    amount: Amount,
    logger: &mut Logger,
) -> ContractResult<()> {
    let payer = ensure_account_sender(ctx)?;
    // F1 (v2.1): capture the balance at entry. During execution
    // `self_balance()` already includes the attached amount, so this equals
    // the pre-existing balance + the attached amount.
    let balance_before = host.self_balance();
    let param: PayableKeyParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    let payable = load_payable(host.state(), param.seller, param.payable_id)?;
    ensure!(matches!(payable.asset, Asset::Ccd), ContractError::WrongAsset);
    match &payable.status {
        Status::Unpaid => {}
        Status::Voided { .. } => return Err(ContractError::Voided),
        _ => return Err(ContractError::WrongStatus),
    }
    ensure!(now_ms <= payable.due.timestamp_millis(), ContractError::PastDue);
    ensure!(
        amount == Amount::from_micro_ccd(payable.amount),
        ContractError::WrongAmount
    );
    ensure!(payer != param.seller, ContractError::SelfAction);
    if let Some(expected) = payable.expected_payer {
        ensure!(payer == expected, ContractError::NotExpectedPayer);
    }
    let approval = host
        .state()
        .vendors
        .get(&(payer, param.seller))
        .map(|v| (*v).clone());
    let strict = host.state().buyer_policy.get(&payer).map(|p| p.strict).unwrap_or(false);
    if let Some(appr) = &approval {
        check_legal_ref(&payable, appr)?;
        check_caps(host.state(), payer, param.seller, appr, payable.amount, now_ms)?;
    } else if strict {
        return Err(ContractError::NotApprovedVendor);
    }
    let registry = host.state().config.cis8004;
    check_seller_agent(host, registry, payable.agent_token, param.seller)?;
    // v3: Verification of Payee, enforced by the chain.
    check_payee_payable(host.state(), &payable, payer, now_ms)?;
    // Effects: Paid, usage, then the atomic forward.
    let mut payable = payable;
    payable.status = Status::Paid {
        payer,
        reservation_expires: None,
        paid_at: Timestamp::from_timestamp_millis(now_ms),
        tx_hash: None,
    };
    let state = host.state_mut();
    let _ = state.payables.insert((param.seller, param.payable_id), payable.clone());
    if let Some(appr) = &approval {
        charge_usage(state, payer, param.seller, appr.period_secs, payable.amount, now_ms);
    }
    host.invoke_transfer(&payable.payee, Amount::from_micro_ccd(payable.amount))
        .map_err(|_| ContractError::TransferFailed)?;
    // F1 (v2.1): the v2 invariant `self_balance() == 0` let a dust donation
    // brick every later `pay_ccd` (-18). The contract now asserts it
    // forwarded exactly the attached amount: the balance after the forward
    // equals the balance observed at entry minus the forwarded amount. A
    // pre-existing stray balance is tolerated; the call neither creates nor
    // loses CCD. (No sweep entrypoint exists, D10: no admin key — the stray
    // balance simply stays in the contract.)
    ensure!(
        host.self_balance() == balance_before - Amount::from_micro_ccd(payable.amount),
        ContractError::Invariant
    );
    logger
        .log(&ContractEvent::Paid {
            schema_version: SCHEMA_VERSION,
            seller: param.seller,
            payable_id: param.payable_id,
            payer,
            amount: payable.amount,
            asset: payable.asset,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "reserve_plt",
    parameter = "PayableKeyParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_reserve_plt(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let sender = ensure_account_sender(ctx)?;
    let param: PayableKeyParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    let payable = load_payable(host.state(), param.seller, param.payable_id)?;
    ensure!(matches!(payable.asset, Asset::Plt(_)), ContractError::WrongAsset);
    match &payable.status {
        Status::Unpaid => {}
        Status::Voided { .. } => return Err(ContractError::Voided),
        _ => return Err(ContractError::NotUnpaid),
    }
    ensure!(now_ms <= payable.due.timestamp_millis(), ContractError::PastDue);
    let expected = payable.expected_payer.ok_or(ContractError::NotExpectedPayer)?;
    ensure!(sender == expected, ContractError::NotExpectedPayer);
    // An approval is ALWAYS required on the PLT rail (H1).
    let approval = host
        .state()
        .vendors
        .get(&(sender, param.seller))
        .map(|v| (*v).clone())
        .ok_or(ContractError::NotApprovedVendor)?;
    check_legal_ref(&payable, &approval)?;
    check_caps(host.state(), sender, param.seller, &approval, payable.amount, now_ms)?;
    let registry = host.state().config.cis8004;
    let reservation_secs = host.state().config.reservation_secs;
    check_seller_agent(host, registry, payable.agent_token, param.seller)?;
    // v3: Verification of Payee, enforced by the chain.
    check_payee_payable(host.state(), &payable, sender, now_ms)?;
    let expires = Timestamp::from_timestamp_millis(now_ms + reservation_secs * 1000);
    let mut payable = payable;
    payable.status = Status::Reserved {
        payer: sender,
        reserved_at: Timestamp::from_timestamp_millis(now_ms),
        expires,
    };
    let state = host.state_mut();
    let _ = state.payables.insert((param.seller, param.payable_id), payable.clone());
    charge_usage(state, sender, param.seller, approval.period_secs, payable.amount, now_ms);
    logger
        .log(&ContractEvent::Reserved {
            schema_version: SCHEMA_VERSION,
            seller: param.seller,
            payable_id: param.payable_id,
            payer: sender,
            expires,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "confirm_plt",
    parameter = "ConfirmPltParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_confirm_plt(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let sender = ensure_account_sender(ctx)?;
    let param: ConfirmPltParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    let payable = load_payable(host.state(), param.seller, param.payable_id)?;
    ensure!(matches!(payable.asset, Asset::Plt(_)), ContractError::WrongAsset);
    let (payer, expires) = match &payable.status {
        Status::Reserved { payer, expires, .. } => (*payer, *expires),
        _ => return Err(ContractError::WrongStatus),
    };
    ensure!(sender == payer, ContractError::NotPayer);
    // R-a: confirm only while now <= expires. The race fix inside the contract.
    ensure!(now_ms <= expires.timestamp_millis(), ContractError::ConfirmAfterWindow);
    ensure!(param.tx_hash != [0u8; 32], ContractError::Invalid);
    ensure!(!host.state().used_tx.contains(&param.tx_hash), ContractError::TxReused);
    let mut payable = payable;
    payable.status = Status::Paid {
        payer,
        reservation_expires: Some(expires),
        paid_at: Timestamp::from_timestamp_millis(now_ms),
        tx_hash: Some(param.tx_hash),
    };
    let state = host.state_mut();
    let _ = state.payables.insert((param.seller, param.payable_id), payable);
    let _ = state.used_tx.insert(param.tx_hash);
    logger
        .log(&ContractEvent::PltConfirmed {
            schema_version: SCHEMA_VERSION,
            seller: param.seller,
            payable_id: param.payable_id,
            payer,
            tx_hash: param.tx_hash,
            reservation_expires: expires,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

/// v2.1 (F5): record the `pay_ccd` transaction hash for a Paid CCD payable.
///
/// The contract cannot observe its own tx hash (see the module docs), so
/// the payer supplies it after the payment finalizes. Checks, in order:
/// zero hash (-14); payable exists (-3); CCD asset (-4); status Paid with
/// no hash recorded yet (-5 otherwise); caller is the recorded payer (-17).
/// The hash is evidence only — the verifier must check it resolves to the
/// `pay_ccd` transaction for this payable; a wrong hash fails receipt
/// verification. The contract never uses it for a money decision.
#[receive(
    contract = "payable_registry_v3",
    name = "record_payment_tx",
    parameter = "RecordPaymentTxParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_record_payment_tx(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let caller = ensure_account_sender(ctx)?;
    let param: RecordPaymentTxParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    ensure!(param.tx_hash != [0u8; 32], ContractError::Invalid);
    let payable = load_payable(host.state(), param.seller, param.payable_id)?;
    ensure!(matches!(payable.asset, Asset::Ccd), ContractError::WrongAsset);
    let (payer, reservation_expires, paid_at, recorded) = match &payable.status {
        Status::Paid { payer, reservation_expires, paid_at, tx_hash } => {
            (*payer, *reservation_expires, *paid_at, *tx_hash)
        }
        _ => return Err(ContractError::WrongStatus),
    };
    ensure!(recorded.is_none(), ContractError::WrongStatus);
    ensure!(caller == payer, ContractError::NotPayer);
    let mut payable = payable;
    payable.status = Status::Paid {
        payer,
        reservation_expires,
        paid_at,
        tx_hash: Some(param.tx_hash),
    };
    let _ = host.state_mut().payables.insert((param.seller, param.payable_id), payable);
    logger
        .log(&ContractEvent::PaymentTxRecorded {
            schema_version: SCHEMA_VERSION,
            seller: param.seller,
            payable_id: param.payable_id,
            payer,
            tx_hash: param.tx_hash,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "expire_reservation",
    parameter = "PayableKeyParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_expire_reservation(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let _sender = ensure_account_sender(ctx)?;
    let param: PayableKeyParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    let payable = load_payable(host.state(), param.seller, param.payable_id)?;
    match &payable.status {
        Status::Reserved { .. } => {}
        _ => return Err(ContractError::WrongStatus),
    }
    let expires = match &payable.status {
        Status::Reserved { expires, .. } => *expires,
        _ => unreachable!(),
    };
    ensure!(now_ms > expires.timestamp_millis(), ContractError::NotExpired);
    let mut payable = payable;
    payable.status = Status::Unpaid;
    // usage is NOT released on expiry (D9).
    let _ = host.state_mut().payables.insert((param.seller, param.payable_id), payable);
    logger
        .log(&ContractEvent::Released {
            schema_version: SCHEMA_VERSION,
            seller: param.seller,
            payable_id: param.payable_id,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "void_payable",
    parameter = "VoidPayableParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_void_payable(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let seller = ensure_account_sender(ctx)?;
    let param: VoidPayableParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    // The key is the sender: a non-seller loads a missing key (-3).
    let payable = load_payable(host.state(), seller, param.payable_id)?;
    let new_status = match &payable.status {
        Status::Unpaid => Status::Voided { at: Timestamp::from_timestamp_millis(now_ms) },
        Status::Reserved { expires, .. } => {
            if now_ms > expires.timestamp_millis() {
                Status::Voided { at: Timestamp::from_timestamp_millis(now_ms) }
            } else {
                return Err(ContractError::VoidWhileReserved);
            }
        }
        Status::Paid { .. } | Status::Voided { .. } => return Err(ContractError::WrongStatus),
    };
    let mut payable = payable;
    payable.status = new_status;
    let _ = host.state_mut().payables.insert((seller, param.payable_id), payable);
    logger
        .log(&ContractEvent::Voided {
            schema_version: SCHEMA_VERSION,
            seller,
            payable_id: param.payable_id,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

// ---------------------------------------------------------------------
// v3: the payee book (Verification of Payee)
// ---------------------------------------------------------------------

/// Seller proposes a payee (or changes an existing payee's details).
/// Checks: account sender (-1); valid identity anchor (-14); seller's agent
/// exists, Active, owned by the seller (-8/-9/-10/-11). A change bumps the
/// version, returns the payee to Proposed and voids every acknowledgment
/// and every payable registered against the old version (-31 at payment).
/// A seller paying itself (payee == seller) is bound at once, cooling-off
/// still applies.
#[receive(
    contract = "payable_registry_v3",
    name = "propose_payee",
    parameter = "ProposePayeeParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_propose_payee(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let seller = ensure_account_sender(ctx)?;
    let param: ProposePayeeParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    ensure!(param.agent_token != 0, ContractError::Invalid);
    ensure!(valid_identity(&param.identity), ContractError::Invalid);
    let registry = host.state().config.cis8004;
    check_seller_agent(host, registry, param.agent_token, seller)?;
    let cooling_ms = host.state().config.cooling_off_secs * 1000;
    let version = host
        .state()
        .payees
        .get(&(seller, param.payee))
        .map(|r| r.version.saturating_add(1))
        .unwrap_or(1);
    let now = Timestamp::from_timestamp_millis(now_ms);
    let self_payee = param.payee == seller;
    let record = PayeeRecord {
        seller,
        payee: param.payee,
        identity: param.identity.clone(),
        status: if self_payee { PayeeStatus::Bound } else { PayeeStatus::Proposed },
        version,
        proposed_at: now,
        bound_at: if self_payee { Some(now) } else { None },
        mature_at: if self_payee {
            Some(Timestamp::from_timestamp_millis(now_ms + cooling_ms))
        } else {
            None
        },
    };
    let _ = host.state_mut().payees.insert((seller, param.payee), record.clone());
    logger
        .log(&ContractEvent::PayeeProposed {
            schema_version: SCHEMA_VERSION,
            seller,
            payee: param.payee,
            version,
            identity: param.identity.clone(),
        })
        .map_err(|_| ContractError::Invariant)?;
    if self_payee {
        logger
            .log(&ContractEvent::PayeeBound {
                schema_version: SCHEMA_VERSION,
                seller,
                payee: param.payee,
                version,
                proof_anchor: param.identity.proof_anchor,
                mature_at: record.mature_at.unwrap_or(now),
            })
            .map_err(|_| ContractError::Invariant)?;
    }
    Ok(())
}

/// The payee account accepts a proposal. The sender IS the payee, so the
/// binding carries the payee's own signature; it must repeat the version
/// (-34) and the proof anchor (-33) it is agreeing to. Starts cooling-off.
#[receive(
    contract = "payable_registry_v3",
    name = "accept_payee",
    parameter = "AcceptPayeeParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_accept_payee(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let payee = ensure_account_sender(ctx)?;
    let param: AcceptPayeeParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    let mut rec = host
        .state()
        .payees
        .get(&(param.seller, payee))
        .map(|r| (*r).clone())
        .ok_or(ContractError::PayeeNotProposed)?;
    ensure!(rec.status == PayeeStatus::Proposed, ContractError::PayeeNotProposed);
    ensure!(rec.version == param.version, ContractError::PayeeVersionMismatch);
    ensure!(rec.identity.proof_anchor == param.proof_anchor, ContractError::AnchorMismatch);
    let cooling_ms = host.state().config.cooling_off_secs * 1000;
    let mature_at = Timestamp::from_timestamp_millis(now_ms + cooling_ms);
    rec.status = PayeeStatus::Bound;
    rec.bound_at = Some(Timestamp::from_timestamp_millis(now_ms));
    rec.mature_at = Some(mature_at);
    let version = rec.version;
    let _ = host.state_mut().payees.insert((param.seller, payee), rec);
    logger
        .log(&ContractEvent::PayeeBound {
            schema_version: SCHEMA_VERSION,
            seller: param.seller,
            payee,
            version,
            proof_anchor: param.proof_anchor,
            mature_at,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

/// Seller or payee revokes a binding at once (never cooled). Bumps the
/// version so every acknowledgment and registered payable is void.
#[receive(
    contract = "payable_registry_v3",
    name = "revoke_payee",
    parameter = "PayeeRefParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_revoke_payee(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let sender = ensure_account_sender(ctx)?;
    let param: PayeeRefParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let mut rec = host
        .state()
        .payees
        .get(&(param.seller, param.payee))
        .map(|r| (*r).clone())
        .ok_or(ContractError::NotFound)?;
    ensure!(sender == param.seller || sender == param.payee, ContractError::NotPayeeParty);
    ensure!(rec.status != PayeeStatus::Revoked, ContractError::PayeeNotBound);
    rec.status = PayeeStatus::Revoked;
    rec.version = rec.version.saturating_add(1);
    rec.mature_at = None;
    let version = rec.version;
    let _ = host.state_mut().payees.insert((param.seller, param.payee), rec);
    logger
        .log(&ContractEvent::PayeeRevoked {
            schema_version: SCHEMA_VERSION,
            seller: param.seller,
            payee: param.payee,
            version,
            by: sender,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

/// A buyer acknowledges one Bound payee version, recording the VoP verdict
/// and the hash of the evidence it relied on. Only Match / Close match are
/// recordable (-36). Self-acknowledgment by the seller or payee is -27.
#[receive(
    contract = "payable_registry_v3",
    name = "acknowledge_payee",
    parameter = "AcknowledgePayeeParam",
    error = "ContractError",
    mutable,
    enable_logger
)]
fn contract_acknowledge_payee(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> ContractResult<()> {
    let buyer = ensure_account_sender(ctx)?;
    let param: AcknowledgePayeeParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    let now_ms = slot_time_millis(ctx);
    ensure!(buyer != param.seller && buyer != param.payee, ContractError::SelfAction);
    ensure!(
        param.verdict == VERDICT_MATCH || param.verdict == VERDICT_CLOSE_MATCH,
        ContractError::VerdictNotPayable
    );
    ensure!(param.evidence_hash != [0u8; 32], ContractError::Invalid);
    let version = bound_payee_version(host.state(), param.seller, param.payee)?;
    ensure!(version == param.version, ContractError::PayeeVersionMismatch);
    let _ = host.state_mut().acks.insert((buyer, param.seller, param.payee), PayeeAck {
        version,
        verdict: param.verdict,
        evidence_hash: param.evidence_hash,
        at: Timestamp::from_timestamp_millis(now_ms),
    });
    logger
        .log(&ContractEvent::PayeeAcknowledged {
            schema_version: SCHEMA_VERSION,
            buyer,
            seller: param.seller,
            payee: param.payee,
            version,
            verdict: param.verdict,
            evidence_hash: param.evidence_hash,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v3",
    name = "get_payee",
    parameter = "PayeeRefParam",
    return_value = "Option<PayeeRecord>",
    error = "ContractError"
)]
fn contract_get_payee(
    ctx: &ReceiveContext,
    host: &Host<State>,
) -> ContractResult<Option<PayeeRecord>> {
    let param: PayeeRefParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    Ok(host.state().payees.get(&(param.seller, param.payee)).map(|r| (*r).clone()))
}

#[receive(
    contract = "payable_registry_v3",
    name = "get_ack",
    parameter = "GetAckParam",
    return_value = "Option<PayeeAck>",
    error = "ContractError"
)]
fn contract_get_ack(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Option<PayeeAck>> {
    let param: GetAckParam = ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    Ok(host.state().acks.get(&(param.buyer, param.seller, param.payee)).map(|a| (*a).clone()))
}

#[receive(
    contract = "payable_registry_v3",
    name = "get_payable",
    parameter = "PayableKeyParam",
    return_value = "Option<Payable>",
    error = "ContractError"
)]
fn contract_get_payable(
    ctx: &ReceiveContext,
    host: &Host<State>,
) -> ContractResult<Option<Payable>> {
    let param: PayableKeyParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    Ok(host.state().payables.get(&(param.seller, param.payable_id)).map(|p| (*p).clone()))
}

#[receive(
    contract = "payable_registry_v3",
    name = "get_vendor",
    parameter = "GetVendorParam",
    return_value = "Option<VendorApproval>",
    error = "ContractError"
)]
fn contract_get_vendor(
    ctx: &ReceiveContext,
    host: &Host<State>,
) -> ContractResult<Option<VendorApproval>> {
    let param: GetVendorParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    Ok(host.state().vendors.get(&(param.buyer, param.seller)).map(|v| (*v).clone()))
}

#[receive(
    contract = "payable_registry_v3",
    name = "get_usage",
    parameter = "GetUsageParam",
    return_value = "u64",
    error = "ContractError"
)]
fn contract_get_usage(ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<u64> {
    let param: GetUsageParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    Ok(host
        .state()
        .usage
        .get(&(param.buyer, param.seller, param.period_index))
        .map(|v| *v)
        .unwrap_or(0))
}

#[receive(
    contract = "payable_registry_v3",
    name = "get_buyer_policy",
    parameter = "GetBuyerPolicyParam",
    return_value = "BuyerPolicy",
    error = "ContractError"
)]
fn contract_get_buyer_policy(
    ctx: &ReceiveContext,
    host: &Host<State>,
) -> ContractResult<BuyerPolicy> {
    let param: GetBuyerPolicyParam =
        ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    Ok(host
        .state()
        .buyer_policy
        .get(&param.buyer)
        .map(|p| *p)
        .unwrap_or(BuyerPolicy { strict: false }))
}

#[receive(
    contract = "payable_registry_v3",
    name = "get_config",
    return_value = "Config",
    error = "ContractError"
)]
fn contract_get_config(_ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Config> {
    Ok(host.state().config)
}
