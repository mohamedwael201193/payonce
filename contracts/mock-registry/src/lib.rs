#![no_std]
//! TEST-ONLY mock CIS-8004 agent registry.
//!
//! Implements `agentOf` with the exact return-value byte layout the real
//! official registry `<12802,0>` returns, as proven live by the merge-round
//! spike (see `concordium-idea-merged-SPIKES.md` §S1):
//!   `Option<AgentView>` = flag byte (0 = None, 1 = Some) then, when Some:
//!   token id (0x08 + u64 LE, 9 bytes), owner (32 bytes),
//!   agent_uri (Option<String>), metadata_hash (Option<[u8;32]>),
//!   external_reference (Option<ExtRef>), agent_wallet (Option<AccountAddress>),
//!   status (u8: 0 = Active, 1 = Revoked).
//!
//! `set_agent` is a test-setup entrypoint (anyone may call it in tests).
//! NEVER deploy this contract to any network.

use concordium_std::*;

/// Status byte values, matching the real registry: 0 = Active, 1 = Revoked.
pub const STATUS_ACTIVE: u8 = 0;
pub const STATUS_REVOKED: u8 = 1;

#[derive(Debug, PartialEq, Eq, Reject, Serial, Deserial, SchemaType)]
pub enum MockError {
    #[from(ParseError)]
    ParseError,
    Invalid,
}

type MockResult<A> = Result<A, MockError>;

/// The external-reference shape the real registry returns. Only `None` is
/// exercised in tests; the struct exists so the `Some` layout stays exact.
#[derive(Debug, Clone, Serial, Deserial, SchemaType)]
pub struct MockExternalReference {
    pub registry: ContractAddress,
    pub kind: u8,
    pub namespace: String,
    pub key_type: String,
    pub public_key: Vec<u8>,
}

/// Agent view as returned by the real `agentOf`. `token_id_bytes` is the
/// 9-byte CIS-2 TokenIdU64 wire form (0x08 length byte + u64 LE).
#[derive(Debug, Clone, Serial, Deserial, SchemaType)]
pub struct MockAgentView {
    pub token_id_bytes: [u8; 9],
    pub owner: AccountAddress,
    pub agent_uri: Option<String>,
    pub metadata_hash: Option<[u8; 32]>,
    pub external_reference: Option<MockExternalReference>,
    pub agent_wallet: Option<AccountAddress>,
    pub status: u8,
}

#[derive(Debug, Clone, Serial, Deserial, SchemaType)]
pub struct MockAgent {
    pub owner: AccountAddress,
    pub status: u8,
}

#[derive(Debug, Serial, Deserial, SchemaType)]
pub struct SetAgentParam {
    pub token_id: u64,
    pub owner: AccountAddress,
    pub status: u8,
}

#[derive(Serial, DeserialWithState, Deletable)]
#[concordium(state_parameter = "S")]
pub struct State<S: HasStateApi = StateApi> {
    agents: StateMap<u64, MockAgent, S>,
    /// Test-only kill switch: when true, `agentOf` rejects, so callers that
    /// cross-call the registry fail closed (-11). NEVER deploy this
    /// contract to any network; the flag exists only so the F-01 test can
    /// make the registry unreachable AFTER a payable is registered.
    broken: StateBox<bool, S>,
}

#[init(contract = "mock_cis8004")]
fn contract_init(
    _ctx: &InitContext,
    state_builder: &mut StateBuilder,
) -> InitResult<State> {
    Ok(State {
        agents: state_builder.new_map(),
        broken: state_builder.new_box(false),
    })
}

#[receive(
    contract = "mock_cis8004",
    name = "set_agent",
    parameter = "SetAgentParam",
    error = "MockError",
    mutable
)]
fn contract_set_agent(ctx: &ReceiveContext, host: &mut Host<State>) -> MockResult<()> {
    let param: SetAgentParam = ctx.parameter_cursor().get()?;
    ensure!(param.status == STATUS_ACTIVE || param.status == STATUS_REVOKED, MockError::Invalid);
    host.state_mut().agents.insert(param.token_id, MockAgent {
        owner: param.owner,
        status: param.status,
    });
    Ok(())
}

/// Test-only kill switch: `set_broken(true)` makes every later `agentOf`
/// reject, simulating an unreachable registry. `set_broken(false)` restores it.
#[receive(
    contract = "mock_cis8004",
    name = "set_broken",
    parameter = "bool",
    error = "MockError",
    mutable
)]
fn contract_set_broken(ctx: &ReceiveContext, host: &mut Host<State>) -> MockResult<()> {
    let param: bool = ctx.parameter_cursor().get()?;
    *host.state_mut().broken = param;
    Ok(())
}

/// `agentOf`: parameter is the 9-byte TokenIdU64 wire form (0x08 + u64 LE).
/// Returns `None` for an unknown token or a malformed parameter.
/// Rejects while the kill switch is on.
#[receive(
    contract = "mock_cis8004",
    name = "agentOf",
    parameter = "[u8; 9]",
    return_value = "Option<MockAgentView>",
    error = "MockError"
)]
fn contract_agent_of(ctx: &ReceiveContext, host: &Host<State>) -> MockResult<Option<MockAgentView>> {
    if *host.state().broken {
        return Err(MockError::Invalid);
    }
    let param: [u8; 9] = ctx.parameter_cursor().get()?;
    if param[0] != 8 {
        return Ok(None);
    }
    let token_id = u64::from_le_bytes(param[1..9].try_into().map_err(|_| MockError::Invalid)?);
    let agent = match host.state().agents.get(&token_id) {
        Some(a) => (*a).clone(),
        None => return Ok(None),
    };
    Ok(Some(MockAgentView {
        token_id_bytes: param,
        owner: agent.owner,
        agent_uri: None,
        metadata_hash: None,
        external_reference: None,
        agent_wallet: None,
        status: agent.status,
    }))
}
