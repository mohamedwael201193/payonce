#![no_std]
//! PayOnce `payable_registry_v2_1` — Concordium Trusted Agents hackathon.
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

/// `schema_version` carried by every event.
pub const SCHEMA_VERSION: u8 = 3;

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
    pub status: Status,
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
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct InitParam {
    pub cis8004: ContractAddress,
    pub reservation_secs: u64,
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

#[init(contract = "payable_registry_v2_1", parameter = "InitParam", error = "ContractError")]
fn contract_init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let param: InitParam = ctx.parameter_cursor().get().map_err(|_| ContractError::Invalid)?;
    ensure!(
        param.reservation_secs > 0 && param.reservation_secs <= RESERVATION_MAX_SECS,
        Reject::from(ContractError::Invalid)
    );
    Ok(State {
        config: Config {
            cis8004: param.cis8004,
            reservation_secs: param.reservation_secs,
        },
        payables: state_builder.new_map(),
        used_tx: state_builder.new_set(),
        vendors: state_builder.new_map(),
        buyer_policy: state_builder.new_map(),
        usage: state_builder.new_map(),
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
    state.usage.insert((buyer, seller, period_index), used.saturating_add(amount));
}

fn check_legal_ref(payable: &Payable, approval: &VendorApproval) -> ContractResult<()> {
    if let Some(legal) = approval.legal_ref {
        ensure!(payable.legal_ref == Some(legal), ContractError::LegalRefMismatch);
    }
    Ok(())
}

#[receive(
    contract = "payable_registry_v2_1",
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
    let state = host.state_mut();
    state.payables.insert((seller, param.payable_id), Payable {
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
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v2_1",
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
    host.state_mut().vendors.insert((buyer, param.seller), VendorApproval {
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
    contract = "payable_registry_v2_1",
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
    contract = "payable_registry_v2_1",
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
    host.state_mut().buyer_policy.insert(buyer, BuyerPolicy { strict: param.strict });
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
    contract = "payable_registry_v2_1",
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
    // Effects: Paid, usage, then the atomic forward.
    let mut payable = payable;
    payable.status = Status::Paid {
        payer,
        reservation_expires: None,
        paid_at: Timestamp::from_timestamp_millis(now_ms),
        tx_hash: None,
    };
    let state = host.state_mut();
    state.payables.insert((param.seller, param.payable_id), payable.clone());
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
    contract = "payable_registry_v2_1",
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
    let expires = Timestamp::from_timestamp_millis(now_ms + reservation_secs * 1000);
    let mut payable = payable;
    payable.status = Status::Reserved {
        payer: sender,
        reserved_at: Timestamp::from_timestamp_millis(now_ms),
        expires,
    };
    let state = host.state_mut();
    state.payables.insert((param.seller, param.payable_id), payable.clone());
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
    contract = "payable_registry_v2_1",
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
    state.payables.insert((param.seller, param.payable_id), payable);
    state.used_tx.insert(param.tx_hash);
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
    contract = "payable_registry_v2_1",
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
    host.state_mut().payables.insert((param.seller, param.payable_id), payable);
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
    contract = "payable_registry_v2_1",
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
    host.state_mut().payables.insert((param.seller, param.payable_id), payable);
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
    contract = "payable_registry_v2_1",
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
    host.state_mut().payables.insert((seller, param.payable_id), payable);
    logger
        .log(&ContractEvent::Voided {
            schema_version: SCHEMA_VERSION,
            seller,
            payable_id: param.payable_id,
        })
        .map_err(|_| ContractError::Invariant)?;
    Ok(())
}

#[receive(
    contract = "payable_registry_v2_1",
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
    contract = "payable_registry_v2_1",
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
    contract = "payable_registry_v2_1",
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
    contract = "payable_registry_v2_1",
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
    contract = "payable_registry_v2_1",
    name = "get_config",
    return_value = "Config",
    error = "ContractError"
)]
fn contract_get_config(_ctx: &ReceiveContext, host: &Host<State>) -> ContractResult<Config> {
    Ok(host.state().config)
}
