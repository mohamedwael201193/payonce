// Read-only: verify v1 contracts exist + wallet balance. No sends, no signing.
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { ContractAddress, AccountAddress } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
for (const [idx, label] of [[13149n, 'payable_registry v1'], [13148n, 'invoice registry'], [12802n, 'CIS-8004 official'], [12801n, 'CIS-8 official']]) {
  try {
    const info = await client.getInstanceInfo(ContractAddress.create(idx, 0n));
    // Integration-lead fix (merge time): SDK v12 names the field sourceModule
    // (length-prefixed hex: 4-byte 0x00000020 + 32-byte hash), not moduleRef.
    const modHex = String(info.sourceModule ?? '');
    const modHash = modHex.startsWith('00000020') ? modHex.slice(8) : modHex;
    console.log(label, `<${idx},0> EXISTS module=${modHash.slice(0, 16)} balance=${info.amount?.microCcdAmount?.toString?.() ?? JSON.stringify(info.amount)} methods=${info.methods?.length}`);
  } catch (e) { console.log(label, 'FAILED:', String(e.message).slice(0,200)); }
}
const acct = AccountAddress.fromBase58('42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB');
const ai = await client.getAccountInfo(acct);
console.log('wallet CCD:', ai.accountAmount?.microCcdAmount?.toString?.() ?? ai.accountAmount);
console.log('wallet nonce:', ai.accountNonce?.toString?.() ?? ai.accountNonce);
console.log('wallet EUDemo:', JSON.stringify(ai.accountTokens ?? ai.tokens ?? 'n/a').slice(0, 400));
