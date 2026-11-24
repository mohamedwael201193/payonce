//! Test-only stand-in for the official CIS-8004 contract, exposing the same `agentOf` wire format.
//! Used by the integration tests only; never deployed on testnet.
#![no_std]
use concordium_std::*;

#[path = "../../payable_registry/src/agent_types.rs"]
mod agent_types;
use agent_types::*;

#[derive(Serialize, Clone, Debug)]
pub struct SetAgentParams {
    pub token: Vec<u8>,
    pub owner: AccountAddress,
    pub revoked: bool,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    agents: StateMap<Vec<u8>, AgentInfo, S>,
}

#[init(contract = "cis8004_mock")]
fn init(_ctx: &InitContext, sb: &mut StateBuilder) -> InitResult<State> {
    Ok(State { agents: sb.new_map() })
}

/// Test helper: create or overwrite an agent with the given owner and status.
#[receive(contract = "cis8004_mock", name = "set_agent", mutable)]
fn set_agent(ctx: &ReceiveContext, host: &mut Host<State>) -> ReceiveResult<()> {
    let p: SetAgentParams = ctx.parameter_cursor().get()?;
    let info = AgentInfo {
        token_id: U8Bytes(p.token.clone()),
        owner_account: p.owner,
        agent_uri: None,
        metadata_hash: None,
        external_reference: None,
        agent_wallet: None,
        status: if p.revoked { AgentStatus::Revoked } else { AgentStatus::Active },
        registered_at: Timestamp::from_timestamp_millis(0),
        revoked_at: None,
        revocation_reason: None,
        on_chain_metadata: Vec::new(),
    };
    let _ = host.state_mut().agents.insert(p.token, info);
    Ok(())
}

/// Same shape as the official entrypoint: parameter ByteList(U8), return Option<AgentInfo>.
#[receive(contract = "cis8004_mock", name = "agentOf")]
fn agent_of(ctx: &ReceiveContext, host: &Host<State>) -> ReceiveResult<Option<AgentInfo>> {
    let t: U8Bytes = ctx.parameter_cursor().get()?;
    Ok(host.state().agents.get(&t.0).map(|a| a.clone()))
}
