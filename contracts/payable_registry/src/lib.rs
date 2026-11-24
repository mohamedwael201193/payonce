//! payable_registry: a zero-balance registry of payable invoices on Concordium testnet.
//!
//! Every payable stores the payment-critical fields on chain (seller, payee, amount, asset, due time,
//! SHA-256 of the invoice document, and the seller's CIS-8004 agent token). `register_payable` and every
//! payment entrypoint cross-call the CIS-8004 `agentOf` view and fail closed unless the agent is Active
//! and owned by the seller.
//!
//! CCD rail: `pay_ccd` is payable. The guard IS the payment: the attached amount must equal the stored
//! amount, and the same call forwards that full amount to the payee. The contract never keeps CCD.
//!
//! PLT rail: contracts cannot move PLTs, so the guard comes first. `reserve_plt` (payer) puts the payable
//! into Reserved for a fixed window; the payer (or the seller) then records the payment tx hash with
//! `confirm_plt`. A reservation that is not confirmed can be expired by anyone after its window.
//!
//! No `init_` prefix in the contract name. Zero balance at rest. Only the configured CIS-8004 instance is
//! trusted for agent checks (a caller-supplied address could answer anything).
#![no_std]
use concordium_std::*;

mod agent_types;
use agent_types::*;

pub const E_UNAUTHORIZED: i32 = -1;
pub const E_DUPLICATE: i32 = -2;
pub const E_NOT_FOUND: i32 = -3;
pub const E_WRONG_ASSET: i32 = -4;
pub const E_WRONG_STATUS: i32 = -5;
pub const E_WRONG_AMOUNT: i32 = -6;
pub const E_PAST_DUE: i32 = -7;
pub const E_AGENT_NOT_FOUND: i32 = -8;
pub const E_AGENT_REVOKED: i32 = -9;
pub const E_AGENT_OWNER_MISMATCH: i32 = -10;
pub const E_CALL_FAILED: i32 = -11;
pub const E_TX_REUSED: i32 = -12;
pub const E_NOT_EXPIRED: i32 = -13;
pub const E_INVALID: i32 = -14;
pub const E_TRANSFER_FAILED: i32 = -15;
pub const E_ALREADY_RESERVED_OR_PAID: i32 = -16;
pub const E_NOT_PAYER_OR_SELLER: i32 = -17;
pub const E_INVARIANT: i32 = -18;

const MAX_RESERVATION_SECS: u64 = 7 * 86_400;

fn rej(code: i32) -> Reject {
    Reject { error_code: core::num::NonZeroI32::new(code).unwrap(), return_value: None }
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub enum Asset {
    Ccd,
    Plt(String),
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub enum Status {
    Unpaid,
    Reserved { payer: AccountAddress, expires: Timestamp },
    /// tx_hash is None on the CCD rail (the pay_ccd transaction itself is the proof).
    Paid { payer: AccountAddress, paid_at: Timestamp, tx_hash: Option<[u8; 32]> },
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Payable {
    pub payable_id: u64,
    pub seller: AccountAddress,
    pub payee: AccountAddress,
    pub amount: u64,
    pub asset: Asset,
    pub due: Timestamp,
    pub doc_hash: [u8; 32],
    pub agent_registry: ContractAddress,
    pub agent_token: Vec<u8>,
    pub status: Status,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Config {
    pub cis8004: ContractAddress,
    pub reservation_secs: u64,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct InitParams {
    pub cis8004: ContractAddress,
    pub reservation_secs: u64,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct RegisterParams {
    pub payable_id: u64,
    pub payee: AccountAddress,
    pub amount: u64,
    pub asset: Asset,
    pub due: Timestamp,
    pub doc_hash: [u8; 32],
    pub agent_token: Vec<u8>,
}

#[derive(Serialize, SchemaType, Clone, Debug)]
pub struct ConfirmParams {
    pub payable_id: u64,
    pub tx_hash: [u8; 32],
}

#[derive(Serial, Debug)]
pub enum Event {
    Registered { payable_id: u64, seller: AccountAddress, payee: AccountAddress, amount: u64 },
    Paid { payable_id: u64, payer: AccountAddress, amount: u64 },
    Reserved { payable_id: u64, payer: AccountAddress, expires: Timestamp },
    PltConfirmed { payable_id: u64, payer: AccountAddress, tx_hash: [u8; 32] },
    Expired { payable_id: u64 },
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    cfg: Config,
    payables: StateMap<u64, Payable, S>,
    used_tx: StateSet<[u8; 32], S>,
}

#[init(contract = "payable_registry", parameter = "InitParams")]
fn init(ctx: &InitContext, sb: &mut StateBuilder) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    if p.reservation_secs == 0 || p.reservation_secs > MAX_RESERVATION_SECS {
        return Err(rej(E_INVALID));
    }
    Ok(State {
        cfg: Config { cis8004: p.cis8004, reservation_secs: p.reservation_secs },
        payables: sb.new_map(),
        used_tx: sb.new_set(),
    })
}

fn sender_acct(ctx: &ReceiveContext) -> Result<AccountAddress, Reject> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        _ => Err(rej(E_UNAUTHORIZED)),
    }
}

fn load(host: &Host<State>, id: u64) -> Result<Payable, Reject> {
    host.state().payables.get(&id).map(|p| p.clone()).ok_or(rej(E_NOT_FOUND))
}

/// Fail-closed CIS-8004 check: the agent must exist, be Active, and be owned by `seller`.
/// Any call failure, unexpected return or missing agent rejects the whole transaction.
fn check_agent(host: &Host<State>, registry: &ContractAddress, token: &[u8], seller: AccountAddress) -> Result<(), Reject> {
    let mut rv = host
        .invoke_contract_read_only(registry, &U8Bytes(token.to_vec()), EntrypointName::new_unchecked("agentOf"), Amount::zero())
        .map_err(|_| rej(E_CALL_FAILED))?
        .ok_or(rej(E_CALL_FAILED))?;
    let info: Option<AgentInfo> = rv.get().map_err(|_| rej(E_CALL_FAILED))?;
    let agent = info.ok_or(rej(E_AGENT_NOT_FOUND))?;
    if agent.status != AgentStatus::Active {
        return Err(rej(E_AGENT_REVOKED));
    }
    if agent.owner_account != seller {
        return Err(rej(E_AGENT_OWNER_MISMATCH));
    }
    Ok(())
}

#[receive(
    contract = "payable_registry",
    name = "register_payable",
    parameter = "RegisterParams",
    enable_logger,
    mutable
)]
fn register_payable(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ReceiveResult<()> {
    let seller = sender_acct(ctx)?;
    let p: RegisterParams = ctx.parameter_cursor().get()?;
    if p.amount == 0 || p.doc_hash == [0u8; 32] || p.agent_token.is_empty() || p.agent_token.len() > 255 {
        return Err(rej(E_INVALID));
    }
    if let Asset::Plt(ref sym) = p.asset {
        if sym.is_empty() || sym.len() > 64 {
            return Err(rej(E_INVALID));
        }
    }
    if p.due <= ctx.metadata().slot_time() {
        return Err(rej(E_PAST_DUE));
    }
    if host.state().payables.get(&p.payable_id).is_some() {
        return Err(rej(E_DUPLICATE));
    }
    let registry = host.state().cfg.cis8004;
    check_agent(host, &registry, &p.agent_token, seller)?;
    logger.log(&Event::Registered { payable_id: p.payable_id, seller, payee: p.payee, amount: p.amount })?;
    let _ = host.state_mut().payables.insert(
        p.payable_id,
        Payable {
            payable_id: p.payable_id,
            seller,
            payee: p.payee,
            amount: p.amount,
            asset: p.asset,
            due: p.due,
            doc_hash: p.doc_hash,
            agent_registry: registry,
            agent_token: p.agent_token,
            status: Status::Unpaid,
        },
    );
    Ok(())
}

/// CCD rail. The attached amount must equal the stored amount; the same call forwards it to the payee.
#[receive(
    contract = "payable_registry",
    name = "pay_ccd",
    parameter = "u64",
    payable,
    enable_logger,
    mutable
)]
fn pay_ccd(ctx: &ReceiveContext, host: &mut Host<State>, amount: Amount, logger: &mut Logger) -> ReceiveResult<()> {
    let payer = sender_acct(ctx)?;
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut p = load(host, id)?;
    if p.asset != Asset::Ccd {
        return Err(rej(E_WRONG_ASSET));
    }
    if p.status != Status::Unpaid {
        return Err(rej(E_WRONG_STATUS));
    }
    let now = ctx.metadata().slot_time();
    if now > p.due {
        return Err(rej(E_PAST_DUE));
    }
    if amount.micro_ccd != p.amount {
        return Err(rej(E_WRONG_AMOUNT));
    }
    check_agent(host, &p.agent_registry, &p.agent_token, p.seller)?;
    p.status = Status::Paid { payer, paid_at: now, tx_hash: None };
    let payee = p.payee;
    let paid_amount = p.amount;
    let _ = host.state_mut().payables.insert(id, p);
    host.invoke_transfer(&payee, amount).map_err(|_| rej(E_TRANSFER_FAILED))?;
    if host.self_balance() != Amount::zero() {
        return Err(rej(E_INVARIANT));
    }
    logger.log(&Event::Paid { payable_id: id, payer, amount: paid_amount })?;
    Ok(())
}

/// PLT rail, step 1: the payer reserves the payable before paying. Only one reservation at a time.
#[receive(
    contract = "payable_registry",
    name = "reserve_plt",
    parameter = "u64",
    enable_logger,
    mutable
)]
fn reserve_plt(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ReceiveResult<()> {
    let payer = sender_acct(ctx)?;
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut p = load(host, id)?;
    if !matches!(p.asset, Asset::Plt(_)) {
        return Err(rej(E_WRONG_ASSET));
    }
    if p.status != Status::Unpaid {
        return Err(rej(E_ALREADY_RESERVED_OR_PAID));
    }
    let now = ctx.metadata().slot_time();
    if now > p.due {
        return Err(rej(E_PAST_DUE));
    }
    check_agent(host, &p.agent_registry, &p.agent_token, p.seller)?;
    let window = host.state().cfg.reservation_secs;
    let expires = Timestamp::from_timestamp_millis(now.timestamp_millis() + window * 1000);
    p.status = Status::Reserved { payer, expires };
    let _ = host.state_mut().payables.insert(id, p);
    logger.log(&Event::Reserved { payable_id: id, payer, expires })?;
    Ok(())
}

/// PLT rail, step 2: the payer (or the seller) records the hash of the payment tx. Each hash is accepted once.
/// Recording is allowed until someone calls expire_reservation after the window.
#[receive(
    contract = "payable_registry",
    name = "confirm_plt",
    parameter = "ConfirmParams",
    enable_logger,
    mutable
)]
fn confirm_plt(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ReceiveResult<()> {
    let who = sender_acct(ctx)?;
    let c: ConfirmParams = ctx.parameter_cursor().get()?;
    let mut p = load(host, c.payable_id)?;
    if !matches!(p.asset, Asset::Plt(_)) {
        return Err(rej(E_WRONG_ASSET));
    }
    let payer = match p.status {
        Status::Reserved { payer, .. } => payer,
        _ => return Err(rej(E_WRONG_STATUS)),
    };
    if who != payer && who != p.seller {
        return Err(rej(E_NOT_PAYER_OR_SELLER));
    }
    if c.tx_hash == [0u8; 32] {
        return Err(rej(E_INVALID));
    }
    if host.state().used_tx.contains(&c.tx_hash) {
        return Err(rej(E_TX_REUSED));
    }
    let _ = host.state_mut().used_tx.insert(c.tx_hash);
    let now = ctx.metadata().slot_time();
    p.status = Status::Paid { payer, paid_at: now, tx_hash: Some(c.tx_hash) };
    let _ = host.state_mut().payables.insert(c.payable_id, p);
    logger.log(&Event::PltConfirmed { payable_id: c.payable_id, payer, tx_hash: c.tx_hash })?;
    Ok(())
}

/// Anyone may release a reservation whose window has passed without a confirmed payment.
#[receive(
    contract = "payable_registry",
    name = "expire_reservation",
    parameter = "u64",
    enable_logger,
    mutable
)]
fn expire_reservation(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> ReceiveResult<()> {
    let id: u64 = ctx.parameter_cursor().get()?;
    let mut p = load(host, id)?;
    let expires = match p.status {
        Status::Reserved { expires, .. } => expires,
        _ => return Err(rej(E_WRONG_STATUS)),
    };
    if ctx.metadata().slot_time() <= expires {
        return Err(rej(E_NOT_EXPIRED));
    }
    p.status = Status::Unpaid;
    let _ = host.state_mut().payables.insert(id, p);
    logger.log(&Event::Expired { payable_id: id })?;
    Ok(())
}

#[receive(contract = "payable_registry", name = "get_payable", parameter = "u64", return_value = "Option<Payable>")]
fn get_payable(ctx: &ReceiveContext, host: &Host<State>) -> ReceiveResult<Option<Payable>> {
    let id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().payables.get(&id).map(|p| p.clone()))
}

#[receive(contract = "payable_registry", name = "get_config", return_value = "Config")]
fn get_config(_ctx: &ReceiveContext, host: &Host<State>) -> ReceiveResult<Config> {
    Ok(host.state().cfg.clone())
}
