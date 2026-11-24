// PayOnce backend — READ-ONLY scan: does seller B own ANY agent token on the
// official CIS-8004 registry <12802,0>? Uses the SDK's CIS2Contract.balanceOf
// (correct CIS-2 encoding) over token ids 1..2000. Control: owner must hold
// token 1476 (balance 1). Prints only token ids + balances — nothing secret.
import { CIS2Contract } from '@concordium/web-sdk';
import { AccountAddress } from '@concordium/web-sdk';
import { grpcClient, getAccountInfo, tokenBalance, toJson } from '../src/chain.mjs';
import { OWNER_ADDRESS, SELLER_B_ADDRESS } from '../src/send.mjs';

const client = grpcClient();
const cis2 = await CIS2Contract.create(client, { index: 12802n, subindex: 0n });

// TokenIdU64 wire bytes: 0x08 + u64 LE, as a hex string.
const tidHex = (id) => {
  const b = Buffer.alloc(9);
  b[0] = 8;
  b.writeBigUInt64LE(BigInt(id), 1);
  return b.toString('hex');
};
const q = (address, ids) => ids.map((id) => ({ tokenId: tidHex(id), address: AccountAddress.fromBase58(address) }));

// Control: owner over [1, 1261, 1476] — expect [0, 0, 1].
const ctrl = await cis2.balanceOf(q(OWNER_ADDRESS, [1, 1261, 1476]));
console.log('control owner balances for tokens [1,1261,1476]:', JSON.stringify(ctrl.map(String)),
  ctrl[2] === 1n && ctrl[0] === 0n && ctrl[1] === 0n ? '(parse OK)' : '(PARSE SUSPECT — aborting scan)');
if (!(ctrl[2] === 1n && ctrl[0] === 0n && ctrl[1] === 0n)) process.exit(1);

const found = [];
for (let start = 1; start <= 2000; start += 500) {
  const ids = [];
  for (let i = start; i < start + 500 && i <= 2000; i++) ids.push(i);
  const bals = await cis2.balanceOf(q(SELLER_B_ADDRESS, ids));
  for (let i = 0; i < ids.length; i++) if (bals[i] > 0n) found.push({ token: ids[i], balance: String(bals[i]) });
  console.log(`scanned ${ids[0]}..${ids[ids.length - 1]}: ${found.length} held so far`);
}
console.log('SELLER B agent tokens on <12802,0> (ids 1..2000):', found.length ? JSON.stringify(found) : 'NONE');

// Balances (finalized block).
const consensus = toJson(await client.getConsensusStatus());
const blockHash = consensus.lastFinalizedBlock;
for (const [addr, label] of [[OWNER_ADDRESS, 'owner'], [SELLER_B_ADDRESS, 'B']]) {
  const info = await getAccountInfo(client, addr, blockHash);
  console.log(`${label}: ${Number(info.accountAmount.microCcdAmount) / 1e6} CCD nonce=${info.accountNonce} EUDemo=${tokenBalance(info, 'EUDemo')}`);
}
