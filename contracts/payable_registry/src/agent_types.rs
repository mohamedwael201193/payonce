//! Wire types of the official CIS-8004 `agentOf` view, copied from the module's embedded schema
//! (module 0e57473715d1..., entrypoint agentOf: ByteList U8 parameter, Option<AgentInfo> return).
//! Shared with the test mock so both sides encode the same bytes.
use concordium_std::*;

/// ByteList with a one-byte length prefix (schema sizeLength U8). Used for the CIS-8004 token id.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct U8Bytes(pub Vec<u8>);

impl Serial for U8Bytes {
    fn serial<W: Write>(&self, out: &mut W) -> Result<(), W::Err> {
        (self.0.len() as u8).serial(out)?;
        out.write_all(&self.0)
    }
}

impl Deserial for U8Bytes {
    fn deserial<R: Read>(source: &mut R) -> ParseResult<Self> {
        let len = u8::deserial(source)?;
        let mut buf = Vec::new();
        buf.resize(len as usize, 0u8);
        source.read_exact(&mut buf)?;
        Ok(U8Bytes(buf))
    }
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub enum AgentStatus {
    Active,
    Revoked,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct Cis8Key {
    pub namespace: String,
    pub key_type: String,
    pub public_key: Vec<u8>,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub enum ExternalKind {
    Cis8(Cis8Key),
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct ExternalRef {
    pub contract_address: ContractAddress,
    pub kind: ExternalKind,
}

#[derive(Serialize, Clone, PartialEq, Eq, Debug)]
pub struct AgentInfo {
    pub token_id: U8Bytes,
    pub owner_account: AccountAddress,
    pub agent_uri: Option<String>,
    pub metadata_hash: Option<[u8; 32]>,
    pub external_reference: Option<ExternalRef>,
    pub agent_wallet: Option<AccountAddress>,
    pub status: AgentStatus,
    pub registered_at: Timestamp,
    pub revoked_at: Option<Timestamp>,
    pub revocation_reason: Option<String>,
    pub on_chain_metadata: Vec<(String, Vec<u8>)>,
}
