import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';
import { AccountAddress, ContractAddress, ReceiveName, Parameter } from '@concordium/web-sdk';
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const CONTRACT = ContractAddress.create(13152n, 0n);
const owner = AccountAddress.fromBase58('42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB');
const b = AccountAddress.fromBase58('4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs');
const ab = (a) => Buffer.from(a.decodedAddress);
const u64le = (n) => { const x = Buffer.alloc(8); x.writeBigUInt64LE(BigInt(n)); return x; };
for (const id of [10, 11, 12, 13, 14, 15, 1, 2, 3, 4, 5]) {
  const res = await client.invokeContract({ contract: CONTRACT, method: ReceiveName.fromString('payable_registry_v2_1.get_payable'), parameter: Parameter.fromBuffer(Buffer.concat([ab(owner), u64le(id)])) });
  const raw = Buffer.from(res.returnValue?.buffer ?? []);
  if (raw[0] === 0) { console.log(`p${id}: absent`); continue; }
  let p = 1 + 32 + 8 + 32 + 8 + 1;
  const assetTag = raw[1 + 32 + 8 + 32 + 8];
  if (assetTag === 1) { const len = raw.readUInt32LE(p); p += 4 + len; }
  p += 8 + 32 + 8;
  const expFlag = raw[p++]; if (expFlag) p += 32;
  const legFlag = raw[p++]; if (legFlag) p += 32;
  const st = raw[p++];
  let extra = '';
  if (st === 2) { const payer = raw.subarray(p, p + 32).toString('hex').slice(0, 8); p += 32; const re = raw[p++]; if (re) p += 8; const at = Number(raw.readBigUInt64LE(p)); extra = ` payer=${payer}… at=${new Date(at).toISOString()}`; }
  if (st === 1) { const payer = raw.subarray(p, p + 32).toString('hex').slice(0, 8); p += 32; const at = Number(raw.readBigUInt64LE(p)); p += 8; const ex = Number(raw.readBigUInt64LE(p)); extra = ` payer=${payer}… at=${at} exp=${ex}`; }
  console.log(`p${id}: status=${['Unpaid', 'Reserved', 'Paid', 'Voided'][st]}${extra}`);
}
const oi = await client.getAccountInfo(owner);
const bi = await client.getAccountInfo(b);
console.log('owner nonce:', String(oi.accountNonce?.nonce ?? oi.accountNonce), 'CCD:', Number(oi.accountAmount.microCcdAmount) / 1e6);
console.log('B nonce:', String(bi.accountNonce?.nonce ?? bi.accountNonce), 'CCD:', Number(bi.accountAmount.microCcdAmount) / 1e6);
