//! Integration tests: payable_registry against the CIS-8004 test mock, all in one test Chain.
//! Every reject path of every entrypoint is covered, plus the CCD and PLT rail happy paths.
//! Build the wasm first: `cargo concordium build --out payable_registry.wasm.v1` (this crate) and
//! `cargo concordium build --out cis8004_mock.wasm.v1` (../cis8004_mock).
use concordium_smart_contract_testing::*;
use concordium_std::{ContractIndex, ContractSubIndex, Serial, Timestamp};
use payable_registry::*;
use cis8004_mock_params as mock;

mod cis8004_mock_params {
    // Same wire shape as the mock's SetAgentParams (token: Vec<u8>, owner, revoked).
    use concordium_std::*;
    #[derive(Serial)]
    pub struct SetAgentParams {
        pub token: Vec<u8>,
        pub owner: AccountAddress,
        pub revoked: bool,
    }
}

const ADMIN: AccountAddress = AccountAddress([9u8; 32]);
const SELLER: AccountAddress = AccountAddress([1u8; 32]);
const PAYEE: AccountAddress = AccountAddress([2u8; 32]);
const PAYER: AccountAddress = AccountAddress([3u8; 32]);
const OTHER: AccountAddress = AccountAddress([4u8; 32]);
const T0: u64 = 1_800_000_000_000; // 2027-01-15, ms
const DAY_MS: u64 = 86_400_000;
const TOKEN: [u8; 8] = [0, 0, 0, 0, 0, 0, 0, 1];
const CCD_PRICE: u64 = 1_000_000; // 1 CCD in micro
const PLT_AMOUNT: u64 = 10_000; // 0.01 EUDemo raw (6 decimals)
const WINDOW: u64 = 300; // reservation window, seconds
const DOC: [u8; 32] = [7u8; 32];

const E_UNAUTHORIZED: i32 = -1;
const E_DUPLICATE: i32 = -2;
const E_NOT_FOUND: i32 = -3;
const E_WRONG_ASSET: i32 = -4;
const E_WRONG_STATUS: i32 = -5;
const E_WRONG_AMOUNT: i32 = -6;
const E_PAST_DUE: i32 = -7;
const E_AGENT_NOT_FOUND: i32 = -8;
const E_AGENT_REVOKED: i32 = -9;
const E_AGENT_OWNER_MISMATCH: i32 = -10;
const E_CALL_FAILED: i32 = -11;
const E_TX_REUSED: i32 = -12;
const E_NOT_EXPIRED: i32 = -13;
const E_INVALID: i32 = -14;
const E_ALREADY_RESERVED_OR_PAID: i32 = -16;
const E_NOT_PAYER_OR_SELLER: i32 = -17;

struct Env {
    chain: Chain,
    reg: ContractAddress,
    cis: ContractAddress,
}

fn deploy<P: Serial>(chain: &mut Chain, path: &str, name: &str, param: &P) -> ContractAddress {
    let m = module_load_v1(path).unwrap_or_else(|e| panic!("load {path}: {e:?}"));
    let mod_ref = chain.module_deploy_v1(Signer::with_one_key(), ADMIN, m).expect("deploy").module_reference;
    chain
        .contract_init(
            Signer::with_one_key(),
            ADMIN,
            Energy::from(100_000),
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref,
                init_name: OwnedContractName::new_unchecked(format!("init_{name}")),
                param: OwnedParameter::from_serial(param).unwrap(),
            },
        )
        .expect("init")
        .contract_address
}

fn up<P: Serial>(chain: &mut Chain, c: ContractAddress, who: AccountAddress, entry: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    upa(chain, c, who, entry, p, Amount::zero())
}

fn upa<P: Serial>(chain: &mut Chain, c: ContractAddress, who: AccountAddress, entry: &str, p: &P, amount: Amount) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(
        Signer::with_one_key(),
        who,
        Address::Account(who),
        Energy::from(1_000_000),
        UpdateContractPayload { amount, address: c, receive_name: OwnedReceiveName::new_unchecked(entry.to_string()), message: OwnedParameter::from_serial(p).unwrap() },
    )
}

fn view<P: Serial>(chain: &Chain, c: ContractAddress, entry: &str, p: &P) -> ContractInvokeSuccess {
    chain
        .contract_invoke(ADMIN, Address::Account(ADMIN), Energy::from(1_000_000), UpdateContractPayload { amount: Amount::zero(), address: c, receive_name: OwnedReceiveName::new_unchecked(entry.to_string()), message: OwnedParameter::from_serial(p).unwrap() })
        .expect("view")
}

fn code(r: Result<ContractInvokeSuccess, ContractInvokeError>) -> i32 {
    r.err().expect("expected revert").reject_code().expect("reject code")
}

fn avail(chain: &Chain, a: AccountAddress) -> u64 {
    chain.account_balance_available(a).expect("account").micro_ccd
}

fn contract_bal(chain: &Chain, c: ContractAddress) -> u64 {
    chain.contract_balance(c).expect("contract").micro_ccd
}


fn get(chain: &Chain, reg: ContractAddress, id: u64) -> Option<Payable> {
    view(chain, reg, "payable_registry.get_payable", &id).parse_return_value::<Option<Payable>>().unwrap()
}

fn reg_params(id: u64, asset: Asset, amount: u64) -> RegisterParams {
    RegisterParams {
        payable_id: id,
        payee: PAYEE,
        amount,
        asset,
        due: Timestamp::from_timestamp_millis(T0 + 30 * DAY_MS),
        doc_hash: DOC,
        agent_token: TOKEN.to_vec(),
    }
}

fn env(reservation_secs: u64) -> Env {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(T0)).build().unwrap();
    for a in [ADMIN, SELLER, PAYEE, PAYER, OTHER] {
        chain.create_account(Account::new(a, Amount::from_ccd(1_000)));
    }
    let cis = deploy(&mut chain, "../cis8004_mock/cis8004_mock.wasm.v1", "cis8004_mock", &());
    up(&mut chain, cis, ADMIN, "cis8004_mock.set_agent", &mock::SetAgentParams { token: TOKEN.to_vec(), owner: SELLER, revoked: false }).expect("set agent");
    let reg = deploy(&mut chain, "payable_registry.wasm.v1", "payable_registry", &InitParams { cis8004: cis, reservation_secs });
    Env { chain, reg, cis }
}

fn with_ccd_and_plt(e: &mut Env) {
    up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, CCD_PRICE)).expect("register ccd");
    up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &reg_params(2, Asset::Plt("EUDemo".into()), PLT_AMOUNT)).expect("register plt");
}

// ---------- register_payable ----------

#[test]
fn register_stores_payment_critical_fields() {
    let mut e = env(WINDOW);
    up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, CCD_PRICE)).expect("register");
    let p = get(&e.chain, e.reg, 1).expect("stored");
    assert_eq!(p.seller, SELLER);
    assert_eq!(p.payee, PAYEE);
    assert_eq!(p.amount, CCD_PRICE);
    assert_eq!(p.asset, Asset::Ccd);
    assert_eq!(p.doc_hash, DOC);
    assert_eq!(p.agent_registry, e.cis);
    assert_eq!(p.agent_token, TOKEN.to_vec());
    assert_eq!(p.status, Status::Unpaid);
    assert_eq!(contract_bal(&e.chain, e.reg), 0);
}

#[test]
fn register_rejects_duplicate() {
    let mut e = env(WINDOW);
    up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, CCD_PRICE)).unwrap();
    assert_eq!(code(up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, 5))), E_DUPLICATE);
}

#[test]
fn register_rejects_non_owner_of_agent() {
    let mut e = env(WINDOW);
    assert_eq!(code(up(&mut e.chain, e.reg, OTHER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, CCD_PRICE))), E_AGENT_OWNER_MISMATCH);
}

#[test]
fn register_rejects_unknown_agent_token() {
    let mut e = env(WINDOW);
    let mut p = reg_params(1, Asset::Ccd, CCD_PRICE);
    p.agent_token = vec![9u8; 8];
    assert_eq!(code(up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &p)), E_AGENT_NOT_FOUND);
}

#[test]
fn register_rejects_revoked_agent() {
    let mut e = env(WINDOW);
    up(&mut e.chain, e.cis, ADMIN, "cis8004_mock.set_agent", &mock::SetAgentParams { token: TOKEN.to_vec(), owner: SELLER, revoked: true }).unwrap();
    assert_eq!(code(up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, CCD_PRICE))), E_AGENT_REVOKED);
}

#[test]
fn register_fails_closed_when_agent_registry_unreachable() {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(T0)).build().unwrap();
    for a in [ADMIN, SELLER] {
        chain.create_account(Account::new(a, Amount::from_ccd(1_000)));
    }
    let nowhere = ContractAddress::new(ContractIndex::from(999u64), ContractSubIndex::from(0u64));
    let reg = deploy(&mut chain, "payable_registry.wasm.v1", "payable_registry", &InitParams { cis8004: nowhere, reservation_secs: WINDOW });
    assert_eq!(code(up(&mut chain, reg, SELLER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, CCD_PRICE))), E_CALL_FAILED);
    assert!(get(&chain, reg, 1).is_none());
}

#[test]
fn register_rejects_zero_amount_and_past_due() {
    let mut e = env(WINDOW);
    assert_eq!(code(up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &reg_params(1, Asset::Ccd, 0))), E_INVALID);
    let mut p = reg_params(1, Asset::Ccd, CCD_PRICE);
    p.due = Timestamp::from_timestamp_millis(T0 - 1);
    assert_eq!(code(up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &p)), E_PAST_DUE);
}

// ---------- CCD rail: pay_ccd ----------

#[test]
fn pay_ccd_correct_amount_pays_payee_in_same_call() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    let payee_before = avail(&e.chain, PAYEE);
    upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &1u64, Amount::from_micro_ccd(CCD_PRICE)).expect("pay");
    assert_eq!(avail(&e.chain, PAYEE) - payee_before, CCD_PRICE);
    assert_eq!(contract_bal(&e.chain, e.reg), 0);
    let p = get(&e.chain, e.reg, 1).unwrap();
    assert!(matches!(p.status, Status::Paid { payer, tx_hash: None, .. } if payer == PAYER));
}

#[test]
fn pay_ccd_second_payment_reverts_and_moves_nothing() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &1u64, Amount::from_micro_ccd(CCD_PRICE)).unwrap();
    let payee_before = avail(&e.chain, PAYEE);
    let payer_before = avail(&e.chain, PAYER);
    let r = upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &1u64, Amount::from_micro_ccd(CCD_PRICE));
    assert_eq!(code(r), E_WRONG_STATUS);
    assert_eq!(avail(&e.chain, PAYEE), payee_before, "payee must not receive the reverted amount");
    assert!(payer_before - avail(&e.chain, PAYER) < CCD_PRICE, "payer pays only the fee, not the amount");
    assert_eq!(contract_bal(&e.chain, e.reg), 0);
}

#[test]
fn pay_ccd_wrong_amount_reverts() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    let payee_before = avail(&e.chain, PAYEE);
    let r = upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &1u64, Amount::from_micro_ccd(CCD_PRICE - 1));
    assert_eq!(code(r), E_WRONG_AMOUNT);
    assert_eq!(avail(&e.chain, PAYEE), payee_before);
    assert_eq!(get(&e.chain, e.reg, 1).unwrap().status, Status::Unpaid);
}

#[test]
fn pay_ccd_unregistered_reverts() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    assert_eq!(code(upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &42u64, Amount::from_micro_ccd(CCD_PRICE))), E_NOT_FOUND);
}

#[test]
fn pay_ccd_on_plt_payable_reverts() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    assert_eq!(code(upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &2u64, Amount::from_micro_ccd(PLT_AMOUNT))), E_WRONG_ASSET);
}

#[test]
fn pay_ccd_reverts_when_agent_revoked_after_registration() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    up(&mut e.chain, e.cis, ADMIN, "cis8004_mock.set_agent", &mock::SetAgentParams { token: TOKEN.to_vec(), owner: SELLER, revoked: true }).unwrap();
    assert_eq!(code(upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &1u64, Amount::from_micro_ccd(CCD_PRICE))), E_AGENT_REVOKED);
    assert_eq!(get(&e.chain, e.reg, 1).unwrap().status, Status::Unpaid);
}

#[test]
fn pay_ccd_reverts_after_due() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    e.chain.tick_block_time(Duration::from_millis(31 * DAY_MS));
    assert_eq!(code(upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &1u64, Amount::from_micro_ccd(CCD_PRICE))), E_PAST_DUE);
}

// ---------- PLT rail: reserve_plt / confirm_plt / expire_reservation ----------

const TX_A: [u8; 32] = [0xA1; 32];
const TX_B: [u8; 32] = [0xB2; 32];

#[test]
fn reserve_then_confirm_by_payer_marks_paid_with_tx_hash() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).expect("reserve");
    let p = get(&e.chain, e.reg, 2).unwrap();
    assert!(matches!(p.status, Status::Reserved { payer, .. } if payer == PAYER));
    up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A }).expect("confirm");
    let p = get(&e.chain, e.reg, 2).unwrap();
    assert!(matches!(p.status, Status::Paid { payer, tx_hash: Some(h), .. } if payer == PAYER && h == TX_A));
    assert_eq!(contract_bal(&e.chain, e.reg), 0);
}

#[test]
fn confirm_by_seller_is_allowed() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).unwrap();
    up(&mut e.chain, e.reg, SELLER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A }).expect("seller confirm");
    assert!(matches!(get(&e.chain, e.reg, 2).unwrap().status, Status::Paid { tx_hash: Some(_), .. }));
}

#[test]
fn second_reserve_reverts_while_reserved_and_after_paid() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).unwrap();
    assert_eq!(code(up(&mut e.chain, e.reg, OTHER, "payable_registry.reserve_plt", &2u64)), E_ALREADY_RESERVED_OR_PAID);
    assert_eq!(code(up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64)), E_ALREADY_RESERVED_OR_PAID);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A }).unwrap();
    assert_eq!(code(up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64)), E_ALREADY_RESERVED_OR_PAID);
}

#[test]
fn reserve_on_ccd_payable_reverts() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    assert_eq!(code(up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &1u64)), E_WRONG_ASSET);
}

#[test]
fn reserve_after_due_reverts() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    e.chain.tick_block_time(Duration::from_millis(31 * DAY_MS));
    assert_eq!(code(up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64)), E_PAST_DUE);
}

#[test]
fn confirm_by_stranger_reverts() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).unwrap();
    assert_eq!(code(up(&mut e.chain, e.reg, OTHER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A })), E_NOT_PAYER_OR_SELLER);
    assert!(matches!(get(&e.chain, e.reg, 2).unwrap().status, Status::Reserved { .. }));
}

#[test]
fn confirm_without_reservation_reverts() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    assert_eq!(code(up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A })), E_WRONG_STATUS);
}

#[test]
fn confirm_rejects_reused_tx_hash_and_zero_hash() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    let mut p3 = reg_params(3, Asset::Plt("EUDemo".into()), PLT_AMOUNT);
    p3.payable_id = 3;
    up(&mut e.chain, e.reg, SELLER, "payable_registry.register_payable", &p3).unwrap();
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).unwrap();
    up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A }).unwrap();
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &3u64).unwrap();
    assert_eq!(code(up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 3, tx_hash: TX_A })), E_TX_REUSED);
    assert_eq!(code(up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 3, tx_hash: [0u8; 32] })), E_INVALID);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 3, tx_hash: TX_B }).expect("fresh hash accepted");
}

#[test]
fn expire_reverts_inside_window_then_releases_for_anyone() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).unwrap();
    assert_eq!(code(up(&mut e.chain, e.reg, OTHER, "payable_registry.expire_reservation", &2u64)), E_NOT_EXPIRED);
    e.chain.tick_block_time(Duration::from_seconds(WINDOW + 1));
    up(&mut e.chain, e.reg, OTHER, "payable_registry.expire_reservation", &2u64).expect("expire by third party");
    assert_eq!(get(&e.chain, e.reg, 2).unwrap().status, Status::Unpaid);
    // a released payable can be reserved again, and expire on Unpaid reverts
    up(&mut e.chain, e.reg, OTHER, "payable_registry.reserve_plt", &2u64).expect("re-reserve");
    assert_eq!(code(up(&mut e.chain, e.reg, OTHER, "payable_registry.expire_reservation", &1u64)), E_WRONG_STATUS);
}

#[test]
fn confirm_still_possible_until_someone_expires_the_reservation() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).unwrap();
    e.chain.tick_block_time(Duration::from_seconds(WINDOW + 1));
    up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A }).expect("late confirm before expiry");
    assert!(matches!(get(&e.chain, e.reg, 2).unwrap().status, Status::Paid { .. }));
}

#[test]
fn contract_balance_is_zero_after_full_flow() {
    let mut e = env(WINDOW);
    with_ccd_and_plt(&mut e);
    upa(&mut e.chain, e.reg, PAYER, "payable_registry.pay_ccd", &1u64, Amount::from_micro_ccd(CCD_PRICE)).unwrap();
    up(&mut e.chain, e.reg, PAYER, "payable_registry.reserve_plt", &2u64).unwrap();
    up(&mut e.chain, e.reg, PAYER, "payable_registry.confirm_plt", &ConfirmParams { payable_id: 2, tx_hash: TX_A }).unwrap();
    assert_eq!(contract_bal(&e.chain, e.reg), 0);
    let cfg = view(&e.chain, e.reg, "payable_registry.get_config", &()).parse_return_value::<Config>().unwrap();
    assert_eq!(cfg.cis8004, e.cis);
    assert_eq!(cfg.reservation_secs, WINDOW);
}

#[test]
fn init_rejects_zero_or_oversized_window() {
    let mut chain = Chain::builder().block_time(Timestamp::from_timestamp_millis(T0)).build().unwrap();
    chain.create_account(Account::new(ADMIN, Amount::from_ccd(1_000)));
    let m = module_load_v1("payable_registry.wasm.v1").unwrap();
    let mod_ref = chain.module_deploy_v1(Signer::with_one_key(), ADMIN, m).unwrap().module_reference;
    for secs in [0u64, 7 * 86_400 + 1] {
        let r = chain.contract_init(
            Signer::with_one_key(),
            ADMIN,
            Energy::from(100_000),
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref,
                init_name: OwnedContractName::new_unchecked("init_payable_registry".into()),
                param: OwnedParameter::from_serial(&InitParams { cis8004: ContractAddress::new(ContractIndex::from(1u64), ContractSubIndex::from(0u64)), reservation_secs: secs }).unwrap(),
            },
        );
        assert!(r.is_err(), "window {secs} must be rejected");
    }
}
