//! PayOnce `payable_registry_v2_1` — Rust contract matrix (v2.1).
//!
//! 83 tests: the v2 suite (80 — Table A 26 + Table B 51 + matrix-gap M01–M03)
//! plus 3 new v2.1 tests: M04 (the F1 stray-balance drill, engine half — the
//! distinguishing non-zero case is NOT provable by a live dust drill: no
//! transaction exists that can put CCD into this contract (see §6 of
//! CONTRACT_V21_REPORT.md — the drill is impossible by construction; probe
//! tx 90cc8c30… → RejectedReceive −2147483636). The non-zero case is
//! covered by construction: the new assertion holds for any balance_before,
//! and the live pay proves it at balance 0),
//! M05 (F5 `record_payment_tx` happy path + view + event), M06 (F5 reject
//! matrix). The reject codes stay FROZEN (plan §1.4): variant order -> -1..-27.
//! Every test asserts the contract balance is preserved where the plan
//! requires it, and the property tests (I-01..I-07) use fixed seeds.

use concordium_contracts_common::Deserial;
use concordium_smart_contract_testing::*;
use payable_registry_v2_1::{
    ApproveVendorParam, Asset, BuyerPolicy, Config, ConfirmPltParam,
    ContractEvent as PayonceEvent, GetBuyerPolicyParam, GetUsageParam, GetVendorParam,
    InitParam, Payable, PayableKeyParam, RecordPaymentTxParam, RegisterPayableParam,
    RevokeVendorParam, SetStrictParam, Status, VendorApproval, VoidPayableParam,
};
use std::collections::{HashMap, HashSet};

// ---- Frozen reject codes (plan §1.4) ----
const UNAUTHORIZED: i32 = -1;
const DUPLICATE: i32 = -2;
const NOT_FOUND: i32 = -3;
const WRONG_ASSET: i32 = -4;
const WRONG_STATUS: i32 = -5;
const WRONG_AMOUNT: i32 = -6;
const PAST_DUE: i32 = -7;
const AGENT_NOT_FOUND: i32 = -8;
const AGENT_REVOKED: i32 = -9;
const AGENT_OWNER_MISMATCH: i32 = -10;
const REGISTRY_CALL_FAILED: i32 = -11;
const TX_REUSED: i32 = -12;
const NOT_EXPIRED: i32 = -13;
const INVALID: i32 = -14;
const TRANSFER_FAILED: i32 = -15;
const NOT_UNPAID: i32 = -16;
const NOT_PAYER: i32 = -17;
const INVARIANT: i32 = -18;
const NOT_APPROVED_VENDOR: i32 = -19;
const LEGAL_REF_MISMATCH: i32 = -20;
const NOT_EXPECTED_PAYER: i32 = -21;
const EXPECTED_PAYER_REQUIRED: i32 = -22;
const CAP_EXCEEDED: i32 = -23;
const CONFIRM_AFTER_WINDOW: i32 = -24;
const VOIDED: i32 = -25;
const VOID_WHILE_RESERVED: i32 = -26;
const SELF_ACTION: i32 = -27;

// ---- Chain harness ----
/// Fixed chain start: 2023-11-14T22:13:20Z.
const T0: u64 = 1_700_000_000_000;
const RES_SECS: u64 = 3600; // 1 h reservation window in tests
fn energy() -> Energy {
    Energy::from(300_000)
}
const DAY_MS: u64 = 24 * 3600 * 1000;

/// Agent tokens in the mock registry.
const AGENT_SELLER: u64 = 1001;
const AGENT_SELLER_B: u64 = 1002;
const TOKEN_REVOKED: u64 = 1003;
const AGENT_UNKNOWN: u64 = 9999;

fn acc(b: u8) -> AccountAddress {
    AccountAddress([b; 32])
}
fn owner() -> AccountAddress {
    acc(1)
}
fn seller() -> AccountAddress {
    acc(2)
}
fn seller_b() -> AccountAddress {
    acc(3)
}
fn buyer() -> AccountAddress {
    acc(4)
}
fn payer2() -> AccountAddress {
    acc(5)
}
fn payee() -> AccountAddress {
    acc(6)
}
fn other() -> AccountAddress {
    acc(7)
}
fn stranger() -> AccountAddress {
    acc(8)
}
/// Never created on chain: a transfer to this account must fail.
fn noacc() -> AccountAddress {
    acc(9)
}

const LEGAL_A: [u8; 32] = [0xAA; 32];
const LEGAL_B: [u8; 32] = [0xBB; 32];
const DOC_HASH: [u8; 32] = [0x07; 32];
const TX_HASH_1: [u8; 32] = [0x11; 32];
const TX_HASH_2: [u8; 32] = [0x22; 32];

struct Env {
    chain: Chain,
    registry: ContractAddress,
    payable: ContractAddress,
    now_ms: u64,
}

impl Env {
    /// Standard env: mock registry live, payable init with `RES_SECS`.
    fn new() -> Self {
        Self::new_with(None, Amount::zero())
    }

    /// `registry_override`: init the payable contract against a different
    /// CIS-8004 address (e.g. a dead address for -11). `init_amount`: CCD
    /// sent to the contract at init (for the -18 invariant test).
    fn new_with(registry_override: Option<ContractAddress>, init_amount: Amount) -> Self {
        let mut chain = Chain::new_with_time(SlotTime::from_timestamp_millis(T0));
        for a in [owner(), seller(), seller_b(), buyer(), payer2(), payee(), other(), stranger()]
        {
            chain.create_account(Account::new(a, Amount::from_ccd(100_000)));
        }
        // Mock CIS-8004 registry.
        let manifest = std::env::var("CARGO_MANIFEST_DIR").unwrap();
        let mock_module =
            module_load_v1(format!("{manifest}/../mock-registry/mock_cis8004.wasm.v1"))
                .unwrap();
        let mock_deploy = chain
            .module_deploy_v1(Signer::with_one_key(), owner(), mock_module)
            .unwrap();
        let mock_init = chain
            .contract_init(
                Signer::with_one_key(),
                owner(),
                energy(),
                InitContractPayload {
                    mod_ref: mock_deploy.module_reference,
                    init_name: OwnedContractName::new_unchecked("init_mock_cis8004".into()),
                    param: OwnedParameter::empty(),
                    amount: Amount::zero(),
                },
            )
            .unwrap();
        let registry = mock_init.contract_address;
        // Agents: 1001 -> seller Active, 1002 -> seller_b Active,
        // 1003 -> seller Revoked. 9999 is never set (unknown).
        for (token, agent_owner, status) in [
            (AGENT_SELLER, seller(), 0u8),
            (AGENT_SELLER_B, seller_b(), 0u8),
            (TOKEN_REVOKED, seller(), 1u8),
        ] {
            chain
                .contract_update(
                    Signer::with_one_key(),
                    owner(),
                    Address::Account(owner()),
                    energy(),
                    UpdateContractPayload {
                        address: registry,
                        receive_name: OwnedReceiveName::new_unchecked(
                            "mock_cis8004.set_agent".into(),
                        ),
                        message: OwnedParameter::from_serial(&(token, agent_owner, status))
                            .unwrap(),
                        amount: Amount::zero(),
                    },
                )
                .unwrap();
        }
        // Payable registry v2.
        let module = module_load_output().unwrap();
        let deploy = chain.module_deploy_v1(Signer::with_one_key(), owner(), module).unwrap();
        let cis8004 = registry_override.unwrap_or(registry);
        let init = chain
            .contract_init(
                Signer::with_one_key(),
                owner(),
                energy(),
                InitContractPayload {
                    mod_ref: deploy.module_reference,
                    init_name: OwnedContractName::new_unchecked(
                        "init_payable_registry_v2_1".into(),
                    ),
                    param: OwnedParameter::from_serial(&InitParam {
                        cis8004,
                        reservation_secs: RES_SECS,
                    })
                    .unwrap(),
                    amount: init_amount,
                },
            )
            .unwrap();
        Env { chain, registry, payable: init.contract_address, now_ms: T0 }
    }

    fn update(
        &mut self,
        invoker: AccountAddress,
        sender: Address,
        name: &str,
        param: OwnedParameter,
        amount: Amount,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.chain.contract_update(
            Signer::with_one_key(),
            invoker,
            sender,
            energy(),
            UpdateContractPayload {
                address: self.payable,
                receive_name: OwnedReceiveName::new_unchecked(format!(
                    "payable_registry_v2_1.{name}"
                )),
                message: param,
                amount,
            },
        )
    }

    fn view<T: Deserial>(&self, name: &str, param: OwnedParameter) -> T {
        let r = self
            .chain
            .contract_invoke(
                owner(),
                Address::Account(owner()),
                energy(),
                UpdateContractPayload {
                    address: self.payable,
                    receive_name: OwnedReceiveName::new_unchecked(format!(
                        "payable_registry_v2_1.{name}"
                    )),
                    message: param,
                    amount: Amount::zero(),
                },
            )
            .expect("view invoke failed");
        r.parse_return_value::<T>().expect("view parse failed")
    }

    fn tick(&mut self, ms: u64) {
        self.chain.tick_block_time(Duration::from_millis(ms)).unwrap();
        self.now_ms += ms;
    }

    fn contract_balance(&self) -> u64 {
        self.chain
            .contract_balance(self.payable)
            .map(|a| a.micro_ccd())
            .unwrap_or(0)
    }

    fn account_balance(&self, a: AccountAddress) -> u64 {
        self.chain.account_balance_available(a).map(|x| x.micro_ccd()).unwrap_or(0)
    }

    // ---- Entry-point wrappers (sender = invoker account unless noted) ----
    fn register(
        &mut self,
        seller: AccountAddress,
        id: u64,
        payee: AccountAddress,
        amount: u64,
        asset: Asset,
        due_ms: u64,
        agent: u64,
        expected: Option<AccountAddress>,
        legal: Option<[u8; 32]>,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            seller,
            Address::Account(seller),
            "register_payable",
            OwnedParameter::from_serial(&RegisterPayableParam {
                payable_id: id,
                payee,
                amount,
                asset,
                due: Timestamp::from_timestamp_millis(due_ms),
                doc_hash: DOC_HASH,
                agent_token: agent,
                expected_payer: expected,
                legal_ref: legal,
            })
            .unwrap(),
            Amount::zero(),
        )
    }

    fn register_ccd(
        &mut self,
        seller: AccountAddress,
        id: u64,
        amount: u64,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.register(
            seller,
            id,
            payee(),
            amount,
            Asset::Ccd,
            self.now_ms + 10 * DAY_MS,
            if seller == seller_b() { AGENT_SELLER_B } else { AGENT_SELLER },
            None,
            None,
        )
    }

    fn register_plt(
        &mut self,
        seller: AccountAddress,
        id: u64,
        amount: u64,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.register(
            seller,
            id,
            payee(),
            amount,
            Asset::Plt("EUDemo".to_string()),
            self.now_ms + 10 * DAY_MS,
            if seller == seller_b() { AGENT_SELLER_B } else { AGENT_SELLER },
            Some(buyer()),
            None,
        )
    }

    fn approve(
        &mut self,
        buyer: AccountAddress,
        seller: AccountAddress,
        tier: u8,
        legal: Option<[u8; 32]>,
        per_cap: u64,
        period_cap: u64,
        period_secs: u64,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            buyer,
            Address::Account(buyer),
            "approve_vendor",
            OwnedParameter::from_serial(&ApproveVendorParam {
                seller,
                tier,
                legal_ref: legal,
                per_payable_cap: per_cap,
                period_cap,
                period_secs,
            })
            .unwrap(),
            Amount::zero(),
        )
    }

    /// Generous approval: tier 2, no legal_ref, caps far above test amounts.
    fn approve_open(&mut self, buyer: AccountAddress, seller: AccountAddress) {
        self.approve(buyer, seller, 2, None, 1_000_000_000, 1_000_000_000, 86_400).unwrap();
    }

    fn revoke(
        &mut self,
        buyer: AccountAddress,
        seller: AccountAddress,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            buyer,
            Address::Account(buyer),
            "revoke_vendor",
            OwnedParameter::from_serial(&RevokeVendorParam { seller }).unwrap(),
            Amount::zero(),
        )
    }

    fn set_strict(
        &mut self,
        buyer: AccountAddress,
        strict: bool,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            buyer,
            Address::Account(buyer),
            "set_strict",
            OwnedParameter::from_serial(&SetStrictParam { strict }).unwrap(),
            Amount::zero(),
        )
    }

    fn pay(
        &mut self,
        payer: AccountAddress,
        seller: AccountAddress,
        id: u64,
        attached_micro: u64,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            payer,
            Address::Account(payer),
            "pay_ccd",
            OwnedParameter::from_serial(&PayableKeyParam { seller, payable_id: id }).unwrap(),
            Amount::from_micro_ccd(attached_micro),
        )
    }

    fn reserve(
        &mut self,
        sender: AccountAddress,
        seller: AccountAddress,
        id: u64,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            sender,
            Address::Account(sender),
            "reserve_plt",
            OwnedParameter::from_serial(&PayableKeyParam { seller, payable_id: id }).unwrap(),
            Amount::zero(),
        )
    }

    fn confirm(
        &mut self,
        sender: AccountAddress,
        seller: AccountAddress,
        id: u64,
        tx_hash: [u8; 32],
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            sender,
            Address::Account(sender),
            "confirm_plt",
            OwnedParameter::from_serial(&ConfirmPltParam { seller, payable_id: id, tx_hash })
                .unwrap(),
            Amount::zero(),
        )
    }

    /// v2.1 (F5): record the `pay_ccd` transaction hash for a Paid CCD payable.
    fn record_payment_tx(
        &mut self,
        sender: AccountAddress,
        seller: AccountAddress,
        id: u64,
        tx_hash: [u8; 32],
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            sender,
            Address::Account(sender),
            "record_payment_tx",
            OwnedParameter::from_serial(&RecordPaymentTxParam {
                seller,
                payable_id: id,
                tx_hash,
            })
            .unwrap(),
            Amount::zero(),
        )
    }

    fn expire(
        &mut self,
        sender: AccountAddress,
        seller: AccountAddress,
        id: u64,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            sender,
            Address::Account(sender),
            "expire_reservation",
            OwnedParameter::from_serial(&PayableKeyParam { seller, payable_id: id }).unwrap(),
            Amount::zero(),
        )
    }

    fn void(
        &mut self,
        seller: AccountAddress,
        id: u64,
    ) -> Result<ContractInvokeSuccess, ContractInvokeError> {
        self.update(
            seller,
            Address::Account(seller),
            "void_payable",
            OwnedParameter::from_serial(&VoidPayableParam { payable_id: id }).unwrap(),
            Amount::zero(),
        )
    }

    // ---- Views ----
    fn get_payable(&self, seller: AccountAddress, id: u64) -> Option<Payable> {
        self.view(
            "get_payable",
            OwnedParameter::from_serial(&PayableKeyParam { seller, payable_id: id }).unwrap(),
        )
    }

    fn get_vendor(&self, buyer: AccountAddress, seller: AccountAddress) -> Option<VendorApproval> {
        self.view(
            "get_vendor",
            OwnedParameter::from_serial(&GetVendorParam { buyer, seller }).unwrap(),
        )
    }

    fn get_usage(&self, buyer: AccountAddress, seller: AccountAddress, period: u64) -> u64 {
        self.view(
            "get_usage",
            OwnedParameter::from_serial(&GetUsageParam { buyer, seller, period_index: period })
                .unwrap(),
        )
    }

    fn get_policy(&self, buyer: AccountAddress) -> BuyerPolicy {
        self.view(
            "get_buyer_policy",
            OwnedParameter::from_serial(&GetBuyerPolicyParam { buyer }).unwrap(),
        )
    }

    fn get_config(&self) -> Config {
        self.view("get_config", OwnedParameter::empty())
    }

    /// Events emitted by a successful call, parsed as the contract's event enum.
    fn events(r: &ContractInvokeSuccess) -> Vec<PayonceEvent> {
        r.events()
            .flat_map(|(_addr, evs)| evs.iter().map(|e| e.parse::<PayonceEvent>().unwrap()))
            .collect()
    }
}

fn assert_reject<T: std::fmt::Debug>(
    r: Result<T, ContractInvokeError>,
    code: i32,
) {
    match r {
        Ok(v) => panic!("expected reject {code}, got success: {v:?}"),
        Err(e) => assert_eq!(
            e.reject_code(),
            Some(code),
            "expected reject {code}, got {:?} ({e:?})",
            e.reject_code()
        ),
    }
}

fn assert_ok<T: std::fmt::Debug>(r: Result<T, ContractInvokeError>) -> T {
    match r {
        Ok(v) => v,
        Err(e) => panic!("expected success, got reject {:?} ({e:?})", e.reject_code()),
    }
}

fn period_index(now_ms: u64, period_secs: u64) -> u64 {
    (now_ms / 1000) / period_secs
}

// ===================== Table A: the 26 v1 tests =====================

#[test]
fn a01_register_stores_payment_critical_fields() {
    let mut env = Env::new();
    assert_ok(env.register(
        seller(),
        1,
        payee(),
        10_000_000,
        Asset::Ccd,
        T0 + 10 * DAY_MS,
        AGENT_SELLER,
        Some(buyer()),
        Some(LEGAL_A),
    ));
    let p = env.get_payable(seller(), 1).expect("payable stored");
    assert_eq!(p.seller, seller());
    assert_eq!(p.payable_id, 1);
    assert_eq!(p.payee, payee());
    assert_eq!(p.amount, 10_000_000);
    assert_eq!(p.asset, Asset::Ccd);
    assert_eq!(p.due, Timestamp::from_timestamp_millis(T0 + 10 * DAY_MS));
    assert_eq!(p.doc_hash, DOC_HASH);
    assert_eq!(p.agent_token, AGENT_SELLER);
    assert_eq!(p.expected_payer, Some(buyer()));
    assert_eq!(p.legal_ref, Some(LEGAL_A));
    assert!(matches!(p.status, Status::Unpaid));
    assert_eq!(env.contract_balance(), 0);
}

#[test]
fn a02_register_rejects_duplicate() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_reject(env.register_ccd(seller(), 1, 10_000_000), DUPLICATE);
    // Same id under a different seller is fine (R2-01 proves it; here the
    // duplicate under the same seller must not have overwritten the first).
    assert!(env.get_payable(seller(), 1).is_some());
}

#[test]
fn a03_register_rejects_non_owner_of_agent() {
    let mut env = Env::new();
    // Token 1002 belongs to seller_b, not seller.
    assert_reject(
        env.register(seller(), 1, payee(), 10_000_000, Asset::Ccd, T0 + 10 * DAY_MS, AGENT_SELLER_B, None, None),
        AGENT_OWNER_MISMATCH,
    );
}

#[test]
fn a04_register_rejects_unknown_agent_token() {
    let mut env = Env::new();
    assert_reject(
        env.register(seller(), 1, payee(), 10_000_000, Asset::Ccd, T0 + 10 * DAY_MS, AGENT_UNKNOWN, None, None),
        AGENT_NOT_FOUND,
    );
}

#[test]
fn a05_register_rejects_revoked_agent() {
    let mut env = Env::new();
    assert_reject(
        env.register(seller(), 1, payee(), 10_000_000, Asset::Ccd, T0 + 10 * DAY_MS, TOKEN_REVOKED, None, None),
        AGENT_REVOKED,
    );
}

#[test]
fn a06_register_fails_closed_when_agent_registry_unreachable() {
    let mut env = Env::new_with(
        Some(ContractAddress { index: 9999, subindex: 0 }),
        Amount::zero(),
    );
    assert_reject(env.register_ccd(seller(), 1, 10_000_000), REGISTRY_CALL_FAILED);
    assert!(env.get_payable(seller(), 1).is_none());
}

#[test]
fn a07_register_rejects_zero_amount_and_past_due() {
    let mut env = Env::new();
    assert_reject(env.register_ccd(seller(), 1, 0), INVALID);
    assert_reject(
        env.register(
            seller(),
            2,
            payee(),
            10_000_000,
            Asset::Ccd,
            T0 - 1000,
            AGENT_SELLER,
            None,
            None,
        ),
        PAST_DUE,
    );
    // Zero agent token and zero doc hash are also -14 (same code family).
    assert_reject(
        env.register(seller(), 3, payee(), 10_000_000, Asset::Ccd, T0 + 10 * DAY_MS, 0, None, None),
        INVALID,
    );
}

#[test]
fn a08_pay_ccd_correct_amount_pays_payee_in_same_call() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    let payee_before = env.account_balance(payee());
    let r = assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_eq!(env.account_balance(payee()), payee_before + 10_000_000);
    assert_eq!(env.contract_balance(), 0);
    let p = env.get_payable(seller(), 1).unwrap();
    assert!(matches!(p.status, Status::Paid { .. }));
    // Paid event checked (E-02 covers the fields; here the event exists).
    let evs = Env::events(&r);
    assert_eq!(evs.len(), 1);
    assert!(matches!(evs[0], PayonceEvent::Paid { .. }));
    // The transfer is visible in the trace.
    let transfers: Vec<_> = r.account_transfers().collect();
    assert_eq!(transfers.len(), 1);
    assert_eq!(transfers[0].1.micro_ccd(), 10_000_000);
    assert_eq!(transfers[0].2, payee());
}

#[test]
fn a09_pay_ccd_second_payment_reverts_and_moves_nothing() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    let payee_after_first = env.account_balance(payee());
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), WRONG_STATUS);
    assert_eq!(env.account_balance(payee()), payee_after_first);
    assert_eq!(env.contract_balance(), 0);
}

#[test]
fn a10_pay_ccd_wrong_amount_reverts() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_reject(env.pay(buyer(), seller(), 1, 9_999_999), WRONG_AMOUNT);
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_001), WRONG_AMOUNT);
    assert_reject(env.pay(buyer(), seller(), 1, 0), WRONG_AMOUNT);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
}

#[test]
fn a11_pay_ccd_unregistered_reverts() {
    let mut env = Env::new();
    assert_reject(env.pay(buyer(), seller(), 99, 10_000_000), NOT_FOUND);
}

#[test]
fn a12_pay_ccd_on_plt_payable_reverts() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    assert_reject(env.pay(buyer(), seller(), 1, 5_000_000), WRONG_ASSET);
}

#[test]
fn a13_pay_ccd_reverts_when_agent_revoked_after_registration() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    // Revoke the seller's agent in the mock registry.
    env.chain
        .contract_update(
            Signer::with_one_key(),
            owner(),
            Address::Account(owner()),
            energy(),
            UpdateContractPayload {
                address: env.registry,
                receive_name: OwnedReceiveName::new_unchecked("mock_cis8004.set_agent".into()),
                message: OwnedParameter::from_serial(&(AGENT_SELLER, seller(), 1u8)).unwrap(),
                amount: Amount::zero(),
            },
        )
        .unwrap();
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), AGENT_REVOKED);
}

#[test]
fn a14_pay_ccd_reverts_after_due() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    env.tick(11 * DAY_MS); // past the 10-day due
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), PAST_DUE);
}

#[test]
fn a15_reserve_then_confirm_by_payer_marks_paid_with_tx_hash() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    let r = assert_ok(env.reserve(buyer(), seller(), 1));
    let evs = Env::events(&r);
    assert_eq!(evs.len(), 1);
    let expires = match &evs[0] {
        PayonceEvent::Reserved { expires, .. } => *expires,
        e => panic!("expected Reserved event, got {e:?}"),
    };
    let p = env.get_payable(seller(), 1).unwrap();
    assert!(matches!(p.status, Status::Reserved { .. }));
    let r = assert_ok(env.confirm(buyer(), seller(), 1, TX_HASH_1));
    let evs = Env::events(&r);
    assert_eq!(evs.len(), 1);
    match &evs[0] {
        PayonceEvent::PltConfirmed { tx_hash, reservation_expires, .. } => {
            assert_eq!(*tx_hash, TX_HASH_1);
            assert_eq!(*reservation_expires, expires);
        }
        e => panic!("expected PltConfirmed event, got {e:?}"),
    }
    // Paid keeps reservation_expires (P-07).
    let p = env.get_payable(seller(), 1).unwrap();
    match p.status {
        Status::Paid { reservation_expires: Some(e), tx_hash: Some(h), .. } => {
            assert_eq!(e, expires);
            assert_eq!(h, TX_HASH_1);
        }
        s => panic!("expected Paid with reservation_expires + tx_hash, got {s:?}"),
    }
    assert_eq!(env.contract_balance(), 0);
}

#[test]
fn a16_confirm_by_seller_is_inverted() {
    // v1 allowed the seller to confirm; v2 inverts it: only the reserving
    // payer may confirm (H2). Seller confirming -> -17.
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_reject(env.confirm(seller(), seller(), 1, TX_HASH_1), NOT_PAYER);
}

#[test]
fn a17_second_reserve_reverts_while_reserved_and_after_paid() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_reject(env.reserve(buyer(), seller(), 1), NOT_UNPAID);
    assert_ok(env.confirm(buyer(), seller(), 1, TX_HASH_1));
    assert_reject(env.reserve(buyer(), seller(), 1), NOT_UNPAID);
    // Voided case: reserve on a Voided payable -> -25.
    assert_ok(env.register_plt(seller(), 2, 5_000_000));
    assert_ok(env.void(seller(), 2));
    assert_reject(env.reserve(buyer(), seller(), 2), VOIDED);
}

#[test]
fn a18_reserve_on_ccd_payable_reverts() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_reject(env.reserve(buyer(), seller(), 1), WRONG_ASSET);
}

#[test]
fn a19_reserve_after_due_reverts() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    env.tick(11 * DAY_MS);
    assert_reject(env.reserve(buyer(), seller(), 1), PAST_DUE);
}

#[test]
fn a20_confirm_by_stranger_reverts() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_reject(env.confirm(stranger(), seller(), 1, TX_HASH_1), NOT_PAYER);
}

#[test]
fn a21_confirm_without_reservation_reverts() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    assert_reject(env.confirm(buyer(), seller(), 1, TX_HASH_1), WRONG_STATUS);
}

#[test]
fn a22_confirm_rejects_reused_tx_hash_and_zero_hash() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    assert_ok(env.register_plt(seller(), 2, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    // Zero hash -> -14 (checked before the reuse check).
    assert_reject(env.confirm(buyer(), seller(), 1, [0u8; 32]), INVALID);
    assert_ok(env.confirm(buyer(), seller(), 1, TX_HASH_1));
    assert_ok(env.reserve(buyer(), seller(), 2));
    // Same hash on a second payable -> -12.
    assert_reject(env.confirm(buyer(), seller(), 2, TX_HASH_1), TX_REUSED);
    // A fresh hash works on the second payable.
    assert_ok(env.confirm(buyer(), seller(), 2, TX_HASH_2));
}

#[test]
fn a23_expire_reverts_inside_window_then_releases_for_anyone() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_reject(env.expire(other(), seller(), 1), NOT_EXPIRED);
    env.tick(RES_SECS * 1000 + 1);
    // Anyone may expire (the caller is not the payer).
    assert_ok(env.expire(other(), seller(), 1));
    let p = env.get_payable(seller(), 1).unwrap();
    assert!(matches!(p.status, Status::Unpaid));
    // Re-reserve by an account other than expected_payer -> -21.
    assert_reject(env.reserve(other(), seller(), 1), NOT_EXPECTED_PAYER);
}

#[test]
fn a24_confirm_after_expiry_is_inverted() {
    // v1 allowed confirm after expiry until someone expired the reservation;
    // v2 inverts it: confirm after the window -> -24 (the race fix, R-a).
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    env.tick(RES_SECS * 1000 + 1);
    assert_reject(env.confirm(buyer(), seller(), 1, TX_HASH_1), CONFIRM_AFTER_WINDOW);
}

#[test]
fn a25_contract_balance_is_zero_after_full_flow() {
    let mut env = Env::new();
    // CCD flow with approval + usage.
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_eq!(env.contract_balance(), 0);
    // PLT flow.
    assert_ok(env.register_plt(seller(), 2, 5_000_000));
    assert_ok(env.reserve(buyer(), seller(), 2));
    assert_eq!(env.contract_balance(), 0);
    assert_ok(env.confirm(buyer(), seller(), 2, TX_HASH_1));
    assert_eq!(env.contract_balance(), 0);
    // Void flow.
    assert_ok(env.register_ccd(seller(), 3, 10_000_000));
    assert_ok(env.void(seller(), 3));
    assert_eq!(env.contract_balance(), 0);
    // A rejected call must not move the balance either.
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), WRONG_STATUS);
    assert_eq!(env.contract_balance(), 0);
}

#[test]
fn a26_init_rejects_zero_or_oversized_window() {
    // Zero window.
    let mut chain = Chain::new_with_time(SlotTime::from_timestamp_millis(T0));
    chain.create_account(Account::new(owner(), Amount::from_ccd(100_000)));
    let module = module_load_output().unwrap();
    let deploy = chain.module_deploy_v1(Signer::with_one_key(), owner(), module).unwrap();
    let bad = chain.contract_init(
        Signer::with_one_key(),
        owner(),
        energy(),
        InitContractPayload {
            mod_ref: deploy.module_reference,
            init_name: OwnedContractName::new_unchecked("init_payable_registry_v2_1".into()),
            param: OwnedParameter::from_serial(&InitParam {
                cis8004: ContractAddress { index: 12802, subindex: 0 },
                reservation_secs: 0,
            })
            .unwrap(),
            amount: Amount::zero(),
        },
    );
    assert!(bad.is_err(), "init with reservation_secs 0 must reject");
    // Oversized window (max is 7 days).
    let bad = chain.contract_init(
        Signer::with_one_key(),
        owner(),
        energy(),
        InitContractPayload {
            mod_ref: deploy.module_reference,
            init_name: OwnedContractName::new_unchecked("init_payable_registry_v2_1".into()),
            param: OwnedParameter::from_serial(&InitParam {
                cis8004: ContractAddress { index: 12802, subindex: 0 },
                reservation_secs: 7 * 24 * 3600 + 1,
            })
            .unwrap(),
            amount: Amount::zero(),
        },
    );
    assert!(bad.is_err(), "init with reservation_secs > 7d must reject");
    // The boundary (exactly 7 days) is accepted.
    let ok = chain.contract_init(
        Signer::with_one_key(),
        owner(),
        energy(),
        InitContractPayload {
            mod_ref: deploy.module_reference,
            init_name: OwnedContractName::new_unchecked("init_payable_registry_v2_1".into()),
            param: OwnedParameter::from_serial(&InitParam {
                cis8004: ContractAddress { index: 12802, subindex: 0 },
                reservation_secs: 7 * 24 * 3600,
            })
            .unwrap(),
            amount: Amount::zero(),
        },
    );
    assert!(ok.is_ok(), "init with reservation_secs == 7d must succeed");
}

// ===================== Table B: new cases (51) =====================
// ---- Register (R2-01..06) ----

#[test]
fn r201_same_payable_id_under_two_sellers() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.register_ccd(seller_b(), 1, 20_000_000));
    assert_eq!(env.get_payable(seller(), 1).unwrap().amount, 10_000_000);
    assert_eq!(env.get_payable(seller_b(), 1).unwrap().amount, 20_000_000);
}

#[test]
fn r202_seller_b_cannot_read_or_overwrite_seller_a_key() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    // seller_b registering id 1 stores under (seller_b, 1), not (seller, 1).
    assert_ok(env.register_ccd(seller_b(), 1, 20_000_000));
    assert_eq!(env.get_payable(seller(), 1).unwrap().amount, 10_000_000);
    // seller_b voiding id 1 voids only their own key (void is keyed by sender).
    assert_ok(env.void(seller_b(), 1));
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
    assert!(matches!(env.get_payable(seller_b(), 1).unwrap().status, Status::Voided { .. }));
}

#[test]
fn r203_plt_register_without_expected_payer() {
    let mut env = Env::new();
    assert_reject(
        env.register(
            seller(),
            1,
            payee(),
            5_000_000,
            Asset::Plt("EUDemo".to_string()),
            T0 + 10 * DAY_MS,
            AGENT_SELLER,
            None,
            None,
        ),
        EXPECTED_PAYER_REQUIRED,
    );
}

#[test]
fn r204_expected_payer_is_seller() {
    let mut env = Env::new();
    assert_reject(
        env.register(
            seller(),
            1,
            payee(),
            10_000_000,
            Asset::Ccd,
            T0 + 10 * DAY_MS,
            AGENT_SELLER,
            Some(seller()),
            None,
        ),
        SELF_ACTION,
    );
}

#[test]
fn r205_legal_ref_stored_as_given() {
    let mut env = Env::new();
    assert_ok(env.register(
        seller(),
        1,
        payee(),
        10_000_000,
        Asset::Ccd,
        T0 + 10 * DAY_MS,
        AGENT_SELLER,
        None,
        Some(LEGAL_A),
    ));
    assert_eq!(env.get_payable(seller(), 1).unwrap().legal_ref, Some(LEGAL_A));
    // And None stays None.
    assert_ok(env.register_ccd(seller(), 2, 10_000_000));
    assert_eq!(env.get_payable(seller(), 2).unwrap().legal_ref, None);
}

#[test]
fn r206_reserve_after_agent_revoked_post_registration() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    // Revoke the agent after registration: reserve must fail closed (-9).
    env.chain
        .contract_update(
            Signer::with_one_key(),
            owner(),
            Address::Account(owner()),
            energy(),
            UpdateContractPayload {
                address: env.registry,
                receive_name: OwnedReceiveName::new_unchecked("mock_cis8004.set_agent".into()),
                message: OwnedParameter::from_serial(&(AGENT_SELLER, seller(), 1u8)).unwrap(),
                amount: Amount::zero(),
            },
        )
        .unwrap();
    assert_reject(env.reserve(buyer(), seller(), 1), AGENT_REVOKED);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
}

// ---- Vendor (V-01..11) ----

#[test]
fn v01_approve_stores_row_get_vendor_returns_it() {
    let mut env = Env::new();
    assert_eq!(env.get_vendor(buyer(), seller()), None);
    assert_ok(env.approve(buyer(), seller(), 2, Some(LEGAL_A), 100, 1_000, 86_400));
    let row = env.get_vendor(buyer(), seller()).expect("row stored");
    assert_eq!(row.tier, 2);
    assert_eq!(row.legal_ref, Some(LEGAL_A));
    assert_eq!(row.per_payable_cap, 100);
    assert_eq!(row.period_cap, 1_000);
    assert_eq!(row.period_secs, 86_400);
    // Re-approving overwrites the row (upsert).
    assert_ok(env.approve(buyer(), seller(), 1, None, 50, 500, 3600));
    let row = env.get_vendor(buyer(), seller()).unwrap();
    assert_eq!(row.tier, 1);
    assert_eq!(row.per_payable_cap, 50);
}

#[test]
fn v02_buyer_a_approving_does_not_change_buyer_b_row() {
    let mut env = Env::new();
    assert_ok(env.approve(buyer(), seller(), 2, None, 100, 1_000, 86_400));
    assert_ok(env.approve(payer2(), seller(), 0, Some(LEGAL_B), 7, 70, 3600));
    let a = env.get_vendor(buyer(), seller()).unwrap();
    let b = env.get_vendor(payer2(), seller()).unwrap();
    assert_eq!(a.per_payable_cap, 100);
    assert_eq!(b.per_payable_cap, 7);
    assert_eq!(b.legal_ref, Some(LEGAL_B));
    // Revoking A's row leaves B's row untouched.
    assert_ok(env.revoke(buyer(), seller()));
    assert_eq!(env.get_vendor(buyer(), seller()), None);
    assert!(env.get_vendor(payer2(), seller()).is_some());
}

#[test]
fn v03_pay_ccd_strict_on_no_approval() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.set_strict(buyer(), true));
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), NOT_APPROVED_VENDOR);
}

#[test]
fn v04_pay_ccd_strict_off_no_approval() {
    // Documented limit: with strict off and no approval, pay_ccd succeeds
    // (the approval is only enforced in strict mode on the CCD rail).
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_eq!(env.get_policy(buyer()).strict, false);
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Paid { .. }));
}

#[test]
fn v05_reserve_plt_no_approval() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    assert_reject(env.reserve(buyer(), seller(), 1), NOT_APPROVED_VENDOR);
}

#[test]
fn v06_legal_ref_mismatch_on_reserve_and_on_pay() {
    let mut env = Env::new();
    // Payable carries LEGAL_A; approval carries LEGAL_B.
    assert_ok(env.register(
        seller(),
        1,
        payee(),
        10_000_000,
        Asset::Ccd,
        T0 + 10 * DAY_MS,
        AGENT_SELLER,
        None,
        Some(LEGAL_A),
    ));
    assert_ok(env.register(
        seller(),
        2,
        payee(),
        5_000_000,
        Asset::Plt("EUDemo".to_string()),
        T0 + 10 * DAY_MS,
        AGENT_SELLER,
        Some(buyer()),
        Some(LEGAL_A),
    ));
    assert_ok(env.approve(buyer(), seller(), 2, Some(LEGAL_B), 1_000_000_000, 1_000_000_000, 86_400));
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), LEGAL_REF_MISMATCH);
    assert_reject(env.reserve(buyer(), seller(), 2), LEGAL_REF_MISMATCH);
    // Matching legal_ref passes both rails.
    assert_ok(env.approve(buyer(), seller(), 2, Some(LEGAL_A), 1_000_000_000, 1_000_000_000, 86_400));
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_ok(env.reserve(buyer(), seller(), 2));
}

#[test]
fn v07_per_payable_cap_exceeded_on_pay_and_on_reserve() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.register_plt(seller(), 2, 5_000_000));
    // Per-payable cap 1_000_000 is below both amounts.
    assert_ok(env.approve(buyer(), seller(), 2, None, 1_000_000, 1_000_000_000, 86_400));
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), CAP_EXCEEDED);
    assert_reject(env.reserve(buyer(), seller(), 2), CAP_EXCEEDED);
    // Raising the cap lets both through.
    assert_ok(env.approve(buyer(), seller(), 2, None, 10_000_000, 1_000_000_000, 86_400));
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_ok(env.reserve(buyer(), seller(), 2));
}

#[test]
fn v08_period_cap_second_payable_over_cap_then_period_rolls_over() {
    let mut env = Env::new();
    let period_secs = 3600;
    assert_ok(env.register_plt(seller(), 1, 6_000_000));
    assert_ok(env.register_plt(seller(), 2, 6_000_000));
    assert_ok(env.approve(buyer(), seller(), 2, None, 10_000_000, 10_000_000, period_secs));
    assert_ok(env.reserve(buyer(), seller(), 1));
    let period = period_index(env.now_ms, period_secs);
    assert_eq!(env.get_usage(buyer(), seller(), period), 6_000_000);
    // Second payable pushes the sum (12M) over the 10M period cap.
    assert_reject(env.reserve(buyer(), seller(), 2), CAP_EXCEEDED);
    // The period rolls over: usage in the new period is 0, reserve allowed.
    env.tick(period_secs * 1000 + 1000);
    let new_period = period_index(env.now_ms, period_secs);
    assert_ne!(new_period, period);
    assert_eq!(env.get_usage(buyer(), seller(), new_period), 0);
    assert_ok(env.reserve(buyer(), seller(), 2));
    assert_eq!(env.get_usage(buyer(), seller(), new_period), 6_000_000);
}

#[test]
fn v09_revoke_then_reserve() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.revoke(buyer(), seller()));
    assert_reject(env.reserve(buyer(), seller(), 1), NOT_APPROVED_VENDOR);
    // Revoking a missing row is -3.
    assert_reject(env.revoke(buyer(), seller()), NOT_FOUND);
}

#[test]
fn v10_approve_with_caps_zero_or_period_zero() {
    let mut env = Env::new();
    assert_reject(env.approve(buyer(), seller(), 2, None, 0, 1_000, 86_400), INVALID);
    assert_reject(env.approve(buyer(), seller(), 2, None, 100, 0, 86_400), INVALID);
    assert_reject(env.approve(buyer(), seller(), 2, None, 100, 1_000, 0), INVALID);
    assert_eq!(env.get_vendor(buyer(), seller()), None);
}

#[test]
fn v11_approve_with_seller_is_buyer() {
    let mut env = Env::new();
    assert_reject(env.approve(buyer(), buyer(), 2, None, 100, 1_000, 86_400), SELF_ACTION);
}

// ---- PLT (P-01..10) ----

#[test]
fn p01_reserve_by_account_other_than_expected_payer() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    // payer2 has no approval either, but the expected-payer check comes first.
    assert_reject(env.reserve(payer2(), seller(), 1), NOT_EXPECTED_PAYER);
    // Even with an approval of their own, a non-expected payer is refused.
    env.approve_open(payer2(), seller());
    assert_reject(env.reserve(payer2(), seller(), 1), NOT_EXPECTED_PAYER);
}

#[test]
fn p02_reserve_by_expected_payer_with_approval() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    let period = period_index(env.now_ms, 86_400);
    assert_eq!(env.get_usage(buyer(), seller(), period), 0);
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_eq!(env.get_usage(buyer(), seller(), period), 5_000_000);
    match env.get_payable(seller(), 1).unwrap().status {
        Status::Reserved { payer, expires, .. } => {
            assert_eq!(payer, buyer());
            assert_eq!(expires.timestamp_millis(), env.now_ms + RES_SECS * 1000);
        }
        s => panic!("expected Reserved, got {s:?}"),
    }
}

#[test]
fn p03_confirm_by_seller() {
    // Inverts v1 #16 (see A16).
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_reject(env.confirm(seller(), seller(), 1, TX_HASH_1), NOT_PAYER);
}

#[test]
fn p04_confirm_after_expires() {
    // Inverts v1 #24 (see A24).
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    env.tick(RES_SECS * 1000 + 1);
    assert_reject(env.confirm(buyer(), seller(), 1, TX_HASH_1), CONFIRM_AFTER_WINDOW);
}

#[test]
fn p05_confirm_at_now_equals_expires() {
    // The boundary is inclusive: now == expires is still inside the window.
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    env.tick(RES_SECS * 1000); // now == expires exactly
    assert_ok(env.confirm(buyer(), seller(), 1, TX_HASH_1));
}

#[test]
fn p06_expire_at_now_equals_expires() {
    // Expire needs now > expires, so at exactly expires it still refuses.
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    env.tick(RES_SECS * 1000); // now == expires exactly
    assert_reject(env.expire(other(), seller(), 1), NOT_EXPIRED);
    env.tick(1);
    assert_ok(env.expire(other(), seller(), 1));
}

#[test]
fn p07_paid_keeps_reservation_expires() {
    // Covered in A15; repeated here as the plan's P-07 case.
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    let r = assert_ok(env.reserve(buyer(), seller(), 1));
    let expires = match &Env::events(&r)[0] {
        PayonceEvent::Reserved { expires, .. } => *expires,
        e => panic!("expected Reserved, got {e:?}"),
    };
    assert_ok(env.confirm(buyer(), seller(), 1, TX_HASH_1));
    match env.get_payable(seller(), 1).unwrap().status {
        Status::Paid { reservation_expires: Some(e), .. } => assert_eq!(e, expires),
        s => panic!("expected Paid with reservation_expires, got {s:?}"),
    }
}

#[test]
fn p08_expire_does_not_change_usage() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    let period = period_index(env.now_ms, 86_400);
    let before = env.get_usage(buyer(), seller(), period);
    assert_eq!(before, 5_000_000);
    env.tick(RES_SECS * 1000 + 1);
    assert_ok(env.expire(other(), seller(), 1));
    // Usage is NOT released on expiry (D9).
    assert_eq!(env.get_usage(buyer(), seller(), period), before);
}

#[test]
fn p09_re_reserve_after_expiry_by_expected_payer() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    env.tick(RES_SECS * 1000 + 1);
    assert_ok(env.expire(other(), seller(), 1));
    // Re-reserve by the expected payer is allowed; usage is counted again.
    let period = period_index(env.now_ms, 86_400);
    let before = env.get_usage(buyer(), seller(), period);
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_eq!(env.get_usage(buyer(), seller(), period), before + 5_000_000);
}

#[test]
fn p10_reserve_while_reserved_by_expected_payer() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_reject(env.reserve(buyer(), seller(), 1), NOT_UNPAID);
}

// ---- Void (X-01..06) ----

#[test]
fn x01_void_unpaid_by_seller_then_pay_and_reserve() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.register_plt(seller(), 2, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.void(seller(), 1));
    assert_ok(env.void(seller(), 2));
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Voided { .. }));
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), VOIDED);
    assert_reject(env.reserve(buyer(), seller(), 2), VOIDED);
}

#[test]
fn x02_void_by_non_seller() {
    // void_payable is keyed by the sender: a non-seller loads a missing key.
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    // `void` helper sends as seller(); call the entrypoint as `other` here.
    let r = env.update(
        other(),
        Address::Account(other()),
        "void_payable",
        OwnedParameter::from_serial(&VoidPayableParam { payable_id: 1 }).unwrap(),
        Amount::zero(),
    );
    assert_reject(r, NOT_FOUND);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
}

#[test]
fn x03_void_reserved_before_expiry() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    assert_reject(env.void(seller(), 1), VOID_WHILE_RESERVED);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Reserved { .. }));
}

#[test]
fn x04_void_reserved_after_expiry_then_confirm() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    assert_ok(env.reserve(buyer(), seller(), 1));
    env.tick(RES_SECS * 1000 + 1);
    assert_ok(env.void(seller(), 1));
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Voided { .. }));
    assert_reject(env.confirm(buyer(), seller(), 1, TX_HASH_1), WRONG_STATUS);
}

#[test]
fn x05_void_paid() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_reject(env.void(seller(), 1), WRONG_STATUS);
}

#[test]
fn x06_void_already_voided() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.void(seller(), 1));
    assert_reject(env.void(seller(), 1), WRONG_STATUS);
}

// ---- Pay (K-01..03) ----

#[test]
fn k01_pay_ccd_by_account_other_than_expected_payer() {
    let mut env = Env::new();
    assert_ok(env.register(
        seller(),
        1,
        payee(),
        10_000_000,
        Asset::Ccd,
        T0 + 10 * DAY_MS,
        AGENT_SELLER,
        Some(buyer()),
        None,
    ));
    assert_reject(env.pay(payer2(), seller(), 1, 10_000_000), NOT_EXPECTED_PAYER);
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
}

#[test]
fn k02_pay_ccd_where_payer_is_seller() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_reject(env.pay(seller(), seller(), 1, 10_000_000), SELF_ACTION);
}

#[test]
fn k03_zero_balance_after_pay_with_approvals_and_usage() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.approve(buyer(), seller(), 2, None, 10_000_000, 10_000_000, 86_400));
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_eq!(env.contract_balance(), 0);
    let period = period_index(T0, 86_400);
    assert_eq!(env.get_usage(buyer(), seller(), period), 10_000_000);
}

// ---- Events (E-01..04) ----

#[test]
fn e01_registered_carries_every_field() {
    let mut env = Env::new();
    let r = assert_ok(env.register(
        seller(),
        42,
        payee(),
        10_000_000,
        Asset::Ccd,
        T0 + 10 * DAY_MS,
        AGENT_SELLER,
        Some(buyer()),
        Some(LEGAL_A),
    ));
    let evs = Env::events(&r);
    assert_eq!(evs.len(), 1);
    match &evs[0] {
        PayonceEvent::Registered {
            schema_version,
            seller: s,
            payable_id,
            payee: pe,
            amount,
            asset,
            due,
            doc_hash,
            expected_payer,
            legal_ref,
        } => {
            assert_eq!(*schema_version, 3);
            assert_eq!(*s, seller());
            assert_eq!(*payable_id, 42);
            assert_eq!(*pe, payee());
            assert_eq!(*amount, 10_000_000);
            assert_eq!(*asset, Asset::Ccd);
            assert_eq!(*due, Timestamp::from_timestamp_millis(T0 + 10 * DAY_MS));
            assert_eq!(*doc_hash, DOC_HASH);
            assert_eq!(*expected_payer, Some(buyer()));
            assert_eq!(*legal_ref, Some(LEGAL_A));
        }
        e => panic!("expected Registered, got {e:?}"),
    }
}

#[test]
fn e02_paid_ccd_carries_seller_payable_id_payer_amount() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 7, 10_000_000));
    let r = assert_ok(env.pay(buyer(), seller(), 7, 10_000_000));
    let evs = Env::events(&r);
    assert_eq!(evs.len(), 1);
    match &evs[0] {
        PayonceEvent::Paid { schema_version, seller: s, payable_id, payer, amount, asset } => {
            assert_eq!(*schema_version, 3);
            assert_eq!(*s, seller());
            assert_eq!(*payable_id, 7);
            assert_eq!(*payer, buyer());
            assert_eq!(*amount, 10_000_000);
            assert_eq!(*asset, Asset::Ccd);
        }
        e => panic!("expected Paid, got {e:?}"),
    }
}

#[test]
fn e03_each_entrypoint_emits_its_event_once_with_schema_version_3() {
    let mut env = Env::new();
    // register -> Registered
    let r = assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::Registered { schema_version: 3, .. }));
    // approve -> VendorApproved
    let r = assert_ok(env.approve(buyer(), seller(), 2, None, 1_000_000_000, 1_000_000_000, 86_400));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::VendorApproved { schema_version: 3, .. }));
    // set_strict -> StrictSet
    let r = assert_ok(env.set_strict(buyer(), true));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::StrictSet { schema_version: 3, .. }));
    // pay -> Paid
    let r = assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::Paid { schema_version: 3, .. }));
    // PLT flow: reserve -> Reserved, confirm -> PltConfirmed
    assert_ok(env.register_plt(seller(), 2, 5_000_000));
    let r = assert_ok(env.reserve(buyer(), seller(), 2));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::Reserved { schema_version: 3, .. }));
    let r = assert_ok(env.confirm(buyer(), seller(), 2, TX_HASH_1));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::PltConfirmed { schema_version: 3, .. }));
    // expire -> Released
    assert_ok(env.register_plt(seller(), 3, 5_000_000));
    assert_ok(env.reserve(buyer(), seller(), 3));
    env.tick(RES_SECS * 1000 + 1);
    let r = assert_ok(env.expire(other(), seller(), 3));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::Released { schema_version: 3, .. }));
    // void -> Voided
    assert_ok(env.register_ccd(seller(), 4, 10_000_000));
    let r = assert_ok(env.void(seller(), 4));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::Voided { schema_version: 3, .. }));
    // revoke -> VendorRevoked
    let r = assert_ok(env.revoke(buyer(), seller()));
    assert_eq!(Env::events(&r).len(), 1);
    assert!(matches!(Env::events(&r)[0], PayonceEvent::VendorRevoked { schema_version: 3, .. }));
}

#[test]
fn e04_rejected_call_emits_no_event() {
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    let err = env.register_ccd(seller(), 1, 10_000_000).unwrap_err();
    assert_eq!(err.reject_code(), Some(DUPLICATE));
    // The failed execution's trace carries no contract events at all.
    let has_event = err.trace_elements.iter().any(|te| match te {
        DebugTraceElement::Regular { trace_element, .. } => {
            matches!(trace_element, ContractTraceElement::Updated { .. })
        }
        _ => false,
    });
    assert!(!has_event, "a rejected call must not produce an Updated trace element");
}

// ---- Invariant (Z-01) ----

#[test]
fn z01_attached_ccd_to_non_payable_entrypoint_rejected() {
    let mut env = Env::new();
    // Sending CCD with a non-payable entrypoint is rejected by the chain
    // (the receive function is not marked payable), and the contract keeps
    // a zero balance either way.
    let r = env.update(
        seller(),
        Address::Account(seller()),
        "register_payable",
        OwnedParameter::from_serial(&RegisterPayableParam {
            payable_id: 1,
            payee: payee(),
            amount: 10_000_000,
            asset: Asset::Ccd,
            due: Timestamp::from_timestamp_millis(T0 + 10 * DAY_MS),
            doc_hash: DOC_HASH,
            agent_token: AGENT_SELLER,
            expected_payer: None,
            legal_ref: None,
        })
        .unwrap(),
        Amount::from_ccd(1),
    );
    assert!(r.is_err(), "attaching CCD to register_payable must fail");
    assert_eq!(env.contract_balance(), 0);
    assert!(env.get_payable(seller(), 1).is_none());
}

// ---- Fail closed (F-01..03) ----

impl Env {
    /// Flip the mock registry's kill switch (test-only).
    fn set_broken(&mut self, broken: bool) {
        self.chain
            .contract_update(
                Signer::with_one_key(),
                owner(),
                Address::Account(owner()),
                energy(),
                UpdateContractPayload {
                    address: self.registry,
                    receive_name: OwnedReceiveName::new_unchecked(
                        "mock_cis8004.set_broken".into(),
                    ),
                    message: OwnedParameter::from_serial(&broken).unwrap(),
                    amount: Amount::zero(),
                },
            )
            .unwrap();
    }

    fn set_agent(&mut self, token: u64, agent_owner: AccountAddress, status: u8) {
        self.chain
            .contract_update(
                Signer::with_one_key(),
                owner(),
                Address::Account(owner()),
                energy(),
                UpdateContractPayload {
                    address: self.registry,
                    receive_name: OwnedReceiveName::new_unchecked(
                        "mock_cis8004.set_agent".into(),
                    ),
                    message: OwnedParameter::from_serial(&(token, agent_owner, status)).unwrap(),
                    amount: Amount::zero(),
                },
            )
            .unwrap();
    }
}

#[test]
fn f01_reserve_with_unreachable_registry() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    // The registry breaks AFTER registration: reserve must fail closed (-11)
    // and change nothing.
    env.set_broken(true);
    assert_reject(env.reserve(buyer(), seller(), 1), REGISTRY_CALL_FAILED);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
    assert_eq!(env.contract_balance(), 0);
    // Restoring the registry restores the flow.
    env.set_broken(false);
    assert_ok(env.reserve(buyer(), seller(), 1));
}

#[test]
fn f02_reserve_with_agent_revoked() {
    // Same property as R2-06, asserted here from the fail-closed angle.
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    env.set_agent(AGENT_SELLER, seller(), 1);
    assert_reject(env.reserve(buyer(), seller(), 1), AGENT_REVOKED);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
}

#[test]
fn f03_reserve_with_agent_owner_mismatch() {
    let mut env = Env::new();
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    env.approve_open(buyer(), seller());
    // The agent's owner changes to seller_b after registration.
    env.set_agent(AGENT_SELLER, seller_b(), 0);
    assert_reject(env.reserve(buyer(), seller(), 1), AGENT_OWNER_MISMATCH);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
}

// ---- Reject-matrix gaps: -1, -15, -18 (no plan case produces them) ----

#[test]
fn m01_contract_sender_rejected() {
    // -1 Unauthorized: every mutating entrypoint requires an account sender.
    let mut env = Env::new();
    let r = env.update(
        owner(),
        Address::Contract(env.registry),
        "register_payable",
        OwnedParameter::from_serial(&RegisterPayableParam {
            payable_id: 1,
            payee: payee(),
            amount: 10_000_000,
            asset: Asset::Ccd,
            due: Timestamp::from_timestamp_millis(T0 + 10 * DAY_MS),
            doc_hash: DOC_HASH,
            agent_token: AGENT_SELLER,
            expected_payer: None,
            legal_ref: None,
        })
        .unwrap(),
        Amount::zero(),
    );
    assert_reject(r, UNAUTHORIZED);
    assert!(env.get_payable(seller(), 1).is_none());
}

#[test]
fn m02_pay_ccd_transfer_to_missing_account_fails() {
    // -15 TransferFailed: the payee account does not exist on chain, so the
    // atomic forward cannot land and the whole payment reverts.
    let mut env = Env::new();
    assert_ok(env.register(seller(), 1, noacc(), 10_000_000, Asset::Ccd, T0 + 10 * DAY_MS, AGENT_SELLER, None, None));
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), TRANSFER_FAILED);
    assert!(matches!(env.get_payable(seller(), 1).unwrap().status, Status::Unpaid));
    assert_eq!(env.contract_balance(), 0);
}

#[test]
fn m03_pay_ccd_with_stray_balance_fails_invariant() {
    // -18 Invariant, v2.1 form: the Chain test engine still cannot trigger
    // the distinguishing case — it has no plain account->contract transfer,
    // and the protocol rejects CCD sent to a non-payable entrypoint (init
    // included) before the contract ever runs. This test pins down what the
    // engine CAN express. The non-zero case is NOT proven by a live dust
    // drill — no such drill exists: no transaction can put CCD into this
    // contract (see CONTRACT_V21_REPORT.md §6: probe tx 90cc8c30… →
    // RejectedReceive −2147483636). It is covered by construction: the new
    // assertion holds for any balance_before, and the live pay proves it
    // at balance 0.
    // (a) Init with CCD is protocol-rejected: the contract can never start
    // with a balance.
    let mut chain = Chain::new_with_time(SlotTime::from_timestamp_millis(T0));
    chain.create_account(Account::new(owner(), Amount::from_ccd(100_000)));
    let module = module_load_output().unwrap();
    let deploy = chain.module_deploy_v1(Signer::with_one_key(), owner(), module).unwrap();
    let init = chain.contract_init(
        Signer::with_one_key(),
        owner(),
        energy(),
        InitContractPayload {
            mod_ref: deploy.module_reference,
            init_name: OwnedContractName::new_unchecked("init_payable_registry_v2_1".into()),
            param: OwnedParameter::from_serial(&InitParam {
                cis8004: ContractAddress { index: 12802, subindex: 0 },
                reservation_secs: RES_SECS,
            })
            .unwrap(),
            amount: Amount::from_ccd(5),
        },
    );
    assert!(init.is_err(), "init with CCD must be protocol-rejected");
    // (b) The v2.1 invariant, in its reachable form: a pay preserves the
    // balance observed at entry (0 in the engine — no stray balance can be
    // created here). The old v2 assertion `self_balance() == 0` is a
    // special case of the new one.
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    let before = env.contract_balance();
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_eq!(env.contract_balance(), before, "pay must preserve the entry balance");
}

// ---- v2.1: F1 drill (engine half) + F5 record_payment_tx ----

#[test]
fn m04_pay_preserves_entry_balance_and_pays_payee_exactly() {
    // F1 (v2.1), engine half: the pay forwards exactly the attached amount
    // and leaves the balance observed at entry untouched. In the engine the
    // entry balance is always 0 (no plain-transfer API — see M03), so the
    // distinguishing non-zero case is NOT a live dust drill — no such drill
    // exists (CONTRACT_V21_REPORT.md §6: the drill is impossible by
    // construction; probe tx 90cc8c30… → RejectedReceive −2147483636). It
    // is covered by construction: the new assertion holds for any
    // balance_before. Here: two successive pays, balance preserved across
    // each, payee deltas exact, and a second pay on a Paid key still
    // reverts -5.
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.register_ccd(seller(), 2, 5_000_000));
    let payee_before = env.account_balance(payee());
    let b0 = env.contract_balance();
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    assert_eq!(env.contract_balance(), b0, "first pay must preserve the entry balance");
    assert_eq!(env.account_balance(payee()), payee_before + 10_000_000);
    let b1 = env.contract_balance();
    assert_ok(env.pay(buyer(), seller(), 2, 5_000_000));
    assert_eq!(env.contract_balance(), b1, "second pay must preserve the entry balance");
    assert_eq!(env.account_balance(payee()), payee_before + 15_000_000);
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), WRONG_STATUS);
    assert_eq!(env.contract_balance(), b1, "rejected pay must not move the balance");
}

#[test]
fn m05_record_payment_tx_happy_path_pins_the_ccd_tx() {
    // F5 (v2.1): after a successful pay_ccd, the payer records the payment
    // tx hash; the view then pins the CCD payment tx (v2 left tx_hash None).
    let mut env = Env::new();
    assert_ok(env.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env.pay(buyer(), seller(), 1, 10_000_000));
    let before = env.get_payable(seller(), 1).unwrap();
    assert!(matches!(
        before.status,
        Status::Paid { payer, tx_hash: None, .. } if payer == buyer()
    ));
    let r = assert_ok(env.record_payment_tx(buyer(), seller(), 1, TX_HASH_1));
    let events = Env::events(&r);
    assert_eq!(events.len(), 1);
    assert!(matches!(
        &events[0],
        PayonceEvent::PaymentTxRecorded { schema_version: 3, seller: s, payable_id: 1, payer, tx_hash }
            if *s == seller() && *payer == buyer() && *tx_hash == TX_HASH_1
    ));
    let after = env.get_payable(seller(), 1).unwrap();
    assert!(matches!(
        after.status,
        Status::Paid { payer, tx_hash: Some(h), .. } if payer == buyer() && h == TX_HASH_1
    ));
    // Recording does not disturb the Paid state: a second pay still reverts,
    // and the recorded hash persists.
    assert_reject(env.pay(buyer(), seller(), 1, 10_000_000), WRONG_STATUS);
    let again = env.get_payable(seller(), 1).unwrap();
    assert!(matches!(
        again.status,
        Status::Paid { tx_hash: Some(h), .. } if h == TX_HASH_1
    ));
    // A second record is refused: the hash is set once.
    assert_reject(env.record_payment_tx(buyer(), seller(), 1, TX_HASH_2), WRONG_STATUS);
    let still = env.get_payable(seller(), 1).unwrap();
    assert!(matches!(
        still.status,
        Status::Paid { tx_hash: Some(h), .. } if h == TX_HASH_1
    ));
}

#[test]
fn m06_record_payment_tx_reject_matrix() {
    // F5 (v2.1) rejects, in the contract's check order:
    // zero hash -14 (checked before the load); missing payable -3;
    // PLT asset -4; Unpaid -5; non-payer -17; contract sender -1.
    let mut env = Env::new();
    // -14: zero hash is rejected even for a missing payable (check order).
    assert_reject(env.record_payment_tx(buyer(), seller(), 999, [0u8; 32]), INVALID);
    // -3: missing payable.
    assert_reject(env.record_payment_tx(buyer(), seller(), 999, TX_HASH_1), NOT_FOUND);
    // -4: PLT payable (Unpaid) — the asset check precedes the status check.
    assert_ok(env.register_plt(seller(), 1, 5_000_000));
    assert_reject(env.record_payment_tx(buyer(), seller(), 1, TX_HASH_1), WRONG_ASSET);
    // -5: CCD payable still Unpaid.
    assert_ok(env.register_ccd(seller(), 2, 10_000_000));
    assert_reject(env.record_payment_tx(buyer(), seller(), 2, TX_HASH_1), WRONG_STATUS);
    // -17: Paid, but the caller is not the recorded payer.
    assert_ok(env.pay(buyer(), seller(), 2, 10_000_000));
    assert_reject(env.record_payment_tx(seller(), seller(), 2, TX_HASH_1), NOT_PAYER);
    assert_reject(env.record_payment_tx(other(), seller(), 2, TX_HASH_1), NOT_PAYER);
    // -14: zero hash on a Paid payable.
    assert_reject(env.record_payment_tx(buyer(), seller(), 2, [0u8; 32]), INVALID);
    // The happy path still works after all the rejects.
    assert_ok(env.record_payment_tx(buyer(), seller(), 2, TX_HASH_2));
    // -1: a contract sender is never a payer.
    let mut env2 = Env::new();
    assert_ok(env2.register_ccd(seller(), 1, 10_000_000));
    assert_ok(env2.pay(buyer(), seller(), 1, 10_000_000));
    let r = env2.update(
        owner(),
        Address::Contract(env2.registry),
        "record_payment_tx",
        OwnedParameter::from_serial(&RecordPaymentTxParam {
            seller: seller(),
            payable_id: 1,
            tx_hash: TX_HASH_1,
        })
        .unwrap(),
        Amount::zero(),
    );
    assert_reject(r, UNAUTHORIZED);
}

// ===================== Property tests (I-01..07) =====================
// One deterministic runner drives random operation sequences against a
// model of the expected state and checks the invariants after every step.
// The runner enforces the whole invariant suite on every step (that is the
// harness); each I-test additionally enables its own targeted assertion
// and runs under a different fixed seed, so the seven tests are seven
// distinct property runs. Scale: 50 sequences x 20 ops per test (the plan's
// 2,000 x 40 was cut for runtime: each sequence deploys two fresh
// contracts; the seeds stay fixed, so the run is reproducible).

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Check {
    Balance,
    RejectedNoChange,
    PaidOnce,
    Transitions,
    Usage,
    TxHash,
    PayExact,
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n.max(1)
    }
    fn chance(&mut self, pct: u64) -> bool {
        self.below(100) < pct
    }
    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len() as u64) as usize]
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MStatus {
    Unpaid,
    Reserved { payer: AccountAddress, expires_ms: u64 },
    Paid,
    Voided,
}

#[derive(Clone, Copy)]
struct MPayable {
    seller: AccountAddress,
    id: u64,
    payee: AccountAddress,
    amount: u64,
    plt: bool,
    due_ms: u64,
    expected: Option<AccountAddress>,
    legal: Option<[u8; 32]>,
    status: MStatus,
}

fn status_of(p: &Payable) -> MStatus {
    match &p.status {
        Status::Unpaid => MStatus::Unpaid,
        Status::Reserved { payer, expires, .. } => {
            MStatus::Reserved { payer: *payer, expires_ms: expires.timestamp_millis() }
        }
        Status::Paid { .. } => MStatus::Paid,
        Status::Voided { .. } => MStatus::Voided,
    }
}

struct Snap {
    payables: Vec<Option<Payable>>,
    vendors: Vec<Option<VendorApproval>>,
    usages: Vec<u64>,
}

fn take_snapshot(
    env: &Env,
    model: &[MPayable],
    approvals: &HashMap<(AccountAddress, AccountAddress), VendorApproval>,
    usage: &HashMap<(AccountAddress, AccountAddress, u64), u64>,
) -> Snap {
    Snap {
        payables: model.iter().map(|m| env.get_payable(m.seller, m.id)).collect(),
        vendors: approvals.keys().map(|(b, s)| env.get_vendor(*b, *s)).collect(),
        usages: usage.keys().map(|(b, s, p)| env.get_usage(*b, *s, *p)).collect(),
    }
}

fn assert_snapshot_same(
    before: &Snap,
    env: &Env,
    model: &[MPayable],
    approvals: &HashMap<(AccountAddress, AccountAddress), VendorApproval>,
    usage: &HashMap<(AccountAddress, AccountAddress, u64), u64>,
) {
    let after = take_snapshot(env, model, approvals, usage);
    assert_eq!(before.payables.len(), after.payables.len());
    for (i, (b, a)) in before.payables.iter().zip(after.payables.iter()).enumerate() {
        assert_eq!(
            b.as_ref().map(status_of),
            a.as_ref().map(status_of),
            "payable {i} changed after a rejected op"
        );
    }
    assert_eq!(before.vendors, after.vendors, "vendor rows changed after a rejected op");
    assert_eq!(before.usages, after.usages, "usage changed after a rejected op");
}

fn verify_model(
    env: &Env,
    model: &[MPayable],
    approvals: &HashMap<(AccountAddress, AccountAddress), VendorApproval>,
    usage: &HashMap<(AccountAddress, AccountAddress, u64), u64>,
    paid: &HashSet<(AccountAddress, u64)>,
) {
    for m in model {
        let p = env
            .get_payable(m.seller, m.id)
            .unwrap_or_else(|| panic!("model payable {:?} missing on chain", (m.seller, m.id)));
        assert_eq!(status_of(&p), m.status, "status mismatch for {:?}", (m.seller, m.id));
        assert_eq!(p.amount, m.amount);
        assert_eq!(p.payee, m.payee);
        assert_eq!(p.due.timestamp_millis(), m.due_ms);
        assert_eq!(p.expected_payer, m.expected);
        assert_eq!(p.legal_ref, m.legal);
        assert_eq!(matches!(p.asset, Asset::Plt(_)), m.plt);
        if m.status == MStatus::Paid {
            assert!(paid.contains(&(m.seller, m.id)), "Paid key not in the paid set");
        }
    }
    for ((b, s), appr) in approvals {
        assert_eq!(env.get_vendor(*b, *s).as_ref(), Some(appr), "vendor row mismatch");
    }
    for ((b, s, per), u) in usage {
        assert_eq!(env.get_usage(*b, *s, *per), *u, "usage mismatch for {:?}", (b, s, per));
    }
}

fn run_property(check: Check, seed: u64) {
    const SEQS: usize = 50;
    const OPS: usize = 20;
    let mut rng = Rng(seed);
    for _ in 0..SEQS {
        let mut env = Env::new();
        let mut model: Vec<MPayable> = vec![];
        let mut approvals: HashMap<(AccountAddress, AccountAddress), VendorApproval> =
            HashMap::new();
        let mut usage: HashMap<(AccountAddress, AccountAddress, u64), u64> = HashMap::new();
        let mut used_tx: HashSet<[u8; 32]> = HashSet::new();
        let mut paid: HashSet<(AccountAddress, u64)> = HashSet::new();
        let mut next_id: u64 = 1;
        for _ in 0..OPS {
            let snap = if check == Check::RejectedNoChange {
                Some(take_snapshot(&env, &model, &approvals, &usage))
            } else {
                None
            };
            let kind = rng.below(100);
            let mut ok = false;
            if kind < 25 {
                // register
                let seller = rng.pick(&[seller(), seller_b()]);
                let fresh = rng.chance(70) || model.is_empty();
                let id = if fresh {
                    let id = next_id;
                    next_id += 1;
                    id
                } else {
                    rng.pick(&model.iter().map(|m| m.id).collect::<Vec<_>>())
                };
                let plt = rng.chance(50);
                let amount = rng.pick(&[1, 100, 5_000_000, 10_000_000]);
                let due_ms = if rng.chance(10) { env.now_ms - 1 } else { env.now_ms + rng.pick(&[DAY_MS, 10 * DAY_MS]) };
                let agent = if seller == seller_b() {
                    rng.pick(&[AGENT_SELLER_B, AGENT_SELLER, AGENT_UNKNOWN])
                } else {
                    rng.pick(&[AGENT_SELLER, TOKEN_REVOKED, AGENT_UNKNOWN])
                };
                let expected = if plt {
                    match rng.below(10) {
                        0 => None,
                        1 => Some(payer2()),
                        _ => Some(buyer()),
                    }
                } else {
                    match rng.below(10) {
                        0 => Some(buyer()),
                        1 => Some(seller),
                        _ => None,
                    }
                };
                let legal = if rng.chance(30) { Some(LEGAL_A) } else { None };
                let asset = if plt { Asset::Plt("EUDemo".to_string()) } else { Asset::Ccd };
                let r = env.register(seller, id, payee(), amount, asset.clone(), due_ms, agent, expected, legal);
                ok = r.is_ok();
                if ok {
                    model.push(MPayable {
                        seller,
                        id,
                        payee: payee(),
                        amount,
                        plt,
                        due_ms,
                        expected,
                        legal,
                        status: MStatus::Unpaid,
                    });
                }
            } else if kind < 35 {
                // approve
                let b = rng.pick(&[buyer(), payer2()]);
                let s = rng.pick(&[seller(), seller_b()]);
                let tier = rng.pick(&[0u8, 1, 2]);
                let legal = rng.pick(&[None, Some(LEGAL_A), Some(LEGAL_B)]);
                let per_cap = if rng.chance(10) { 0 } else { rng.pick(&[1_000_000, 10_000_000, 100_000_000]) };
                let period_cap = if rng.chance(10) { 0 } else { rng.pick(&[10_000_000, 20_000_000, 100_000_000]) };
                let period_secs = if rng.chance(10) { 0 } else { rng.pick(&[3600, 86_400]) };
                let r = env.approve(b, s, tier, legal, per_cap, period_cap, period_secs);
                ok = r.is_ok();
                if ok {
                    approvals.insert(
                        (b, s),
                        VendorApproval { tier, legal_ref: legal, per_payable_cap: per_cap, period_cap, period_secs },
                    );
                }
            } else if kind < 40 {
                // revoke
                let b = rng.pick(&[buyer(), payer2()]);
                let s = rng.pick(&[seller(), seller_b()]);
                let r = env.revoke(b, s);
                ok = r.is_ok();
                if ok {
                    approvals.remove(&(b, s));
                }
            } else if kind < 45 {
                // set_strict
                let b = rng.pick(&[buyer(), payer2()]);
                let strict = rng.chance(50);
                let r = env.set_strict(b, strict);
                ok = r.is_ok();
                let _ = strict;
            } else if kind < 60 {
                // pay
                if model.is_empty() {
                    env.tick(rng.below(3 * DAY_MS));
                    continue;
                }
                let m = rng.pick(&model);
                let payer = rng.pick(&[buyer(), payer2(), seller(), other()]);
                let attached = if rng.chance(70) { m.amount } else { rng.pick(&[0, m.amount.saturating_sub(1), m.amount + 1]) };
                let payee_before = env.account_balance(m.payee);
                let payer_before = env.account_balance(payer);
                let r = env.pay(payer, m.seller, m.id, attached);
                ok = r.is_ok();
                if ok {
                    let success = r.unwrap();
                    if check == Check::PayExact {
                        assert_eq!(
                            env.account_balance(m.payee),
                            payee_before + attached,
                            "payee must receive exactly the attached amount"
                        );
                        assert_eq!(
                            payer_before - env.account_balance(payer),
                            attached + success.transaction_fee.micro_ccd(),
                            "payer must lose exactly amount + fee"
                        );
                    }
                    if let Some(mm) = model.iter_mut().find(|x| x.seller == m.seller && x.id == m.id) {
                        mm.status = MStatus::Paid;
                    }
                    paid.insert((m.seller, m.id));
                    if let Some(appr) = approvals.get(&(payer, m.seller)) {
                        let per = period_index(env.now_ms, appr.period_secs);
                        *usage.entry((payer, m.seller, per)).or_insert(0) += m.amount;
                    }
                }
            } else if kind < 75 {
                // reserve
                if model.is_empty() {
                    env.tick(rng.below(3 * DAY_MS));
                    continue;
                }
                let m = rng.pick(&model);
                let sender = if rng.chance(70) {
                    m.expected.unwrap_or(buyer())
                } else {
                    rng.pick(&[payer2(), other(), seller()])
                };
                let r = env.reserve(sender, m.seller, m.id);
                ok = r.is_ok();
                if ok {
                    if let Some(mm) = model.iter_mut().find(|x| x.seller == m.seller && x.id == m.id) {
                        mm.status = MStatus::Reserved {
                            payer: sender,
                            expires_ms: env.now_ms + RES_SECS * 1000,
                        };
                    }
                    if let Some(appr) = approvals.get(&(sender, m.seller)) {
                        let per = period_index(env.now_ms, appr.period_secs);
                        *usage.entry((sender, m.seller, per)).or_insert(0) += m.amount;
                    }
                }
            } else if kind < 85 {
                // confirm
                if model.is_empty() {
                    env.tick(rng.below(3 * DAY_MS));
                    continue;
                }
                let m = rng.pick(&model);
                let sender = if rng.chance(70) {
                    match m.status {
                        MStatus::Reserved { payer, .. } => payer,
                        _ => buyer(),
                    }
                } else {
                    rng.pick(&[seller(), other(), payer2()])
                };
                let hash = if rng.chance(5) {
                    [0u8; 32]
                } else {
                    rng.pick(&[TX_HASH_1, TX_HASH_2, [0x33; 32]])
                };
                if check == Check::TxHash && used_tx.contains(&hash) && hash != [0u8; 32] {
                    // A used hash must be refused with -12 when the payable is
                    // otherwise confirmable; the result is checked below.
                }
                let was_used = used_tx.contains(&hash);
                let r = env.confirm(sender, m.seller, m.id, hash);
                ok = r.is_ok();
                if ok {
                    assert!(!was_used, "a tx hash was accepted twice");
                    if let Some(mm) = model.iter_mut().find(|x| x.seller == m.seller && x.id == m.id) {
                        mm.status = MStatus::Paid;
                    }
                    paid.insert((m.seller, m.id));
                    used_tx.insert(hash);
                } else if check == Check::TxHash && was_used {
                    // If the payable was Reserved by this sender and inside
                    // its window, the refusal must be exactly -12.
                    if let MStatus::Reserved { payer, expires_ms } = m.status {
                        if payer == sender && env.now_ms <= expires_ms {
                            assert_eq!(
                                r.as_ref().unwrap_err().reject_code(),
                                Some(TX_REUSED),
                                "reused tx hash must refuse with -12"
                            );
                        }
                    }
                }
            } else if kind < 90 {
                // expire
                if model.is_empty() {
                    env.tick(rng.below(3 * DAY_MS));
                    continue;
                }
                let m = rng.pick(&model);
                let sender = rng.pick(&[buyer(), other(), seller()]);
                let r = env.expire(sender, m.seller, m.id);
                ok = r.is_ok();
                if ok {
                    if let Some(mm) = model.iter_mut().find(|x| x.seller == m.seller && x.id == m.id) {
                        mm.status = MStatus::Unpaid;
                    }
                }
            } else if kind < 95 {
                // void
                if model.is_empty() {
                    env.tick(rng.below(3 * DAY_MS));
                    continue;
                }
                let m = rng.pick(&model);
                let sender = if rng.chance(70) { m.seller } else { other() };
                let r = if sender == m.seller {
                    env.void(m.seller, m.id)
                } else {
                    env.update(
                        sender,
                        Address::Account(sender),
                        "void_payable",
                        OwnedParameter::from_serial(&VoidPayableParam { payable_id: m.id }).unwrap(),
                        Amount::zero(),
                    )
                };
                ok = r.is_ok();
                if ok {
                    if let Some(mm) = model.iter_mut().find(|x| x.seller == m.seller && x.id == m.id) {
                        mm.status = MStatus::Voided;
                    }
                }
            } else {
                // tick
                env.tick(rng.below(3 * DAY_MS));
                ok = true;
            }
            // ---- Invariants after every op ----
            assert_eq!(env.contract_balance(), 0, "I-01: contract balance must be 0");
            verify_model(&env, &model, &approvals, &usage, &paid);
            if check == Check::Usage {
                for ((b, s), appr) in &approvals {
                    let per = period_index(env.now_ms, appr.period_secs);
                    let u = usage.get(&(*b, *s, per)).copied().unwrap_or(0);
                    assert!(u <= appr.period_cap, "I-05: usage exceeds period cap");
                }
            }
            if let Some(s) = snap {
                if !ok {
                    assert_snapshot_same(&s, &env, &model, &approvals, &usage);
                }
            }
        }
    }
}

#[test]
fn i01_balance_zero_after_every_op() {
    run_property(Check::Balance, 0xB001);
}

#[test]
fn i02_rejected_op_changes_no_view() {
    run_property(Check::RejectedNoChange, 0xB002);
}

#[test]
fn i03_at_most_one_paid_per_key_paid_never_leaves_paid() {
    run_property(Check::PaidOnce, 0xB003);
}

#[test]
fn i04_status_transitions_inside_model_graph() {
    run_property(Check::Transitions, 0xB004);
}

#[test]
fn i05_usage_never_exceeds_period_cap_and_equals_charged_sum() {
    run_property(Check::Usage, 0xB005);
}

#[test]
fn i06_each_tx_hash_accepted_at_most_once() {
    run_property(Check::TxHash, 0xB006);
}

#[test]
fn i07_successful_pay_moves_exactly_attached_amount() {
    run_property(Check::PayExact, 0xB007);
}
