// probe.mjs — READ-ONLY live probe (no key, no sends).
// Queries the official CIS-8004 registry <12802,0> agentOf for the agent
// tokens the live matrix needs, and reads the deployer + account B balances.
// Usage: node probe.mjs
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress, ContractAddress, ReceiveName, Parameter } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';

const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const REGISTRY = ContractAddress.create(12802n, 0n);
const DEPLOYER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const ACCOUNT_B = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';

function tokenParam(id) {
  const b = Buffer.alloc(9);
  b[0] = 8;
  b.writeBigUInt64LE(BigInt(id), 1);
  return b;
}

// Parse Option<AgentView> per the layout proven live by the merge-round spike:
// flag, token id (9B), owner (32B), agent_uri Option<String>,
// metadata_hash Option<[u8;32]>, external_reference Option<...>,
// agent_wallet Option<AccountAddress>, status u8.
function parseAgentView(bytes) {
  if (!bytes || bytes.length === 0) return null;
  const b = Buffer.from(bytes);
  let pos = 0;
  const flag = b[pos++];
  if (flag === 0) return null;
  const tokenId = b.readBigUInt64LE(pos + 1);
  pos += 9;
  const owner = b.subarray(pos, pos + 32);
  pos += 32;
  // agent_uri: Option<String> (flag + u32 len + bytes)
  const uriFlag = b[pos++];
  let uri = null;
  if (uriFlag === 1) {
    const len = b.readUInt32LE(pos);
    pos += 4;
    uri = b.subarray(pos, pos + len).toString();
    pos += len;
  }
  // metadata_hash: Option<[u8;32]>
  const mhFlag = b[pos++];
  if (mhFlag === 1) pos += 32;
  // external_reference: Option<ExtRef> (registry ContractAddress 16B + kind u8 + namespace String + key_type String + public_key Vec<u8>)
  const erFlag = b[pos++];
  if (erFlag === 1) {
    pos += 16 + 1;
    for (let i = 0; i < 2; i++) {
      const len = b.readUInt32LE(pos);
      pos += 4 + len;
    }
    const pkLen = b.readUInt32LE(pos);
    pos += 4 + pkLen;
  }
  // agent_wallet: Option<AccountAddress>
  const awFlag = b[pos++];
  if (awFlag === 1) pos += 32;
  const status = b[pos];
  return { tokenId: tokenId.toString(), owner: Buffer.from(owner).toString('hex'), uri, status };
}

for (const id of [1476, 1261, 999999]) {
  const res = await client.invokeContract({
    contract: REGISTRY,
    method: ReceiveName.fromString('CIS-8004.agentOf'),
    parameter: Parameter.fromBuffer(tokenParam(id)),
  });
  const ret = res.returnValue?.buffer ?? res.returnValue;
  const view = parseAgentView(ret);
  console.log(`token ${id}:`, view ? JSON.stringify(view) : 'None (no such agent)');
}

for (const [label, addr] of [['deployer', DEPLOYER], ['account B', ACCOUNT_B]]) {
  const info = await client.getAccountInfo(AccountAddress.fromBase58(addr));
  const bal = Number(info.accountAmount.microCcdAmount) / 1e6;
  const nonce = String(info.accountNonce?.nonce ?? info.accountNonce);
  console.log(`${label} ${addr}: ${bal} CCD, nonce ${nonce}`);
}
console.log('PROBE DONE');
