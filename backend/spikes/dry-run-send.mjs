// Dry-run: validate encodings + the full tx build/sign path WITHOUT submitting.
// 1. Encode register_payable params for payables 6/7, decode them with the
//    decoder proven against tx d8986836, compare every field.
// 2. Build + sign a register update tx with B's signer (no submission).
import { createHash } from 'node:crypto';
import { grpcClient } from '../src/chain.mjs';
import { loadSigners, nextNonce, encodeRegisterPayable, encodePayableId, encodeConfirm, SELLER_B_ADDRESS, PAYEE2_ADDRESS } from '../src/send.mjs';
import { Transaction, Payload, CcdAmount, Energy, ReceiveName, Parameter, AccountAddress, ContractAddress, TransactionExpiry, SequenceNumber } from "@concordium/web-sdk";

function decodeRegister(hex) {
  const b = Buffer.from(hex, 'hex');
  let off = 0;
  const u64 = () => { const v = b.readBigUInt64LE(off); off += 8; return v; };
  const out = {};
  out.payableId = u64().toString();
  out.payee = b.subarray(off, off + 32).toString('hex'); off += 32;
  out.amount = u64().toString();
  out.assetTag = b[off]; off += 1;
  if (out.assetTag === 1) { const len = b.readUInt32LE(off); off += 4; out.symbol = b.subarray(off, off + len).toString(); off += len; }
  out.dueMs = u64().toString();
  out.docHash = b.subarray(off, off + 32).toString('hex'); off += 32;
  out.tokenLen = b.readUInt32LE(off); off += 4;
  out.agentToken = u64().toString();
  out.trailing = b.subarray(off).toString('hex');
  out.totalBytes = b.length;
  return out;
}

const dueMs = Date.now() + 24 * 60 * 60 * 1000;
const doc6 = createHash('sha256').update('test invoice 6').digest('hex');
const doc7 = createHash('sha256').update('test invoice 7').digest('hex');
const payeeHex = Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(PAYEE2_ADDRESS))).toString('hex');

const p6 = encodeRegisterPayable({ payableId: 6, payee: PAYEE2_ADDRESS, amount: 500000, asset: 'CCD', dueMs, docHashHex: doc6, agentToken: 1 });
const d6 = decodeRegister(p6);
console.log('payable 6 decoded:', JSON.stringify(d6));
if (d6.payableId !== '6' || d6.payee !== payeeHex || d6.amount !== '500000' || d6.assetTag !== 0 || d6.dueMs !== String(dueMs) || d6.docHash !== doc6 || d6.tokenLen !== 8 || d6.agentToken !== '1' || d6.trailing !== '') throw new Error('payable 6 encoding mismatch');

const p7 = encodeRegisterPayable({ payableId: 7, payee: PAYEE2_ADDRESS, amount: 10000, asset: 'EUDemo', dueMs, docHashHex: doc7, agentToken: 1 });
const d7 = decodeRegister(p7);
console.log('payable 7 decoded:', JSON.stringify(d7));
if (d7.payableId !== '7' || d7.payee !== payeeHex || d7.amount !== '10000' || d7.assetTag !== 1 || d7.symbol !== 'EUDemo' || d7.dueMs !== String(dueMs) || d7.docHash !== doc7 || d7.tokenLen !== 8 || d7.agentToken !== '1' || d7.trailing !== '') throw new Error('payable 7 encoding mismatch');

console.log('pay_ccd param (id 6):', encodePayableId(6));
console.log('confirm param (id 7 + hash):', encodeConfirm({ payableId: 7, txHashHex: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }).length / 2, 'bytes');

// Build + sign a register tx (no submission).
const client = grpcClient();
const signers = loadSigners();
const nonce = await nextNonce(client, SELLER_B_ADDRESS);
console.log('B nonce (live):', nonce);
const payload = Payload.updateContract({
  amount: CcdAmount.fromMicroCcd(0n),
  address: ContractAddress.create(13149n, 0n),
  receiveName: ReceiveName.fromString('payable_registry.register_payable'),
  message: Parameter.fromHexString(p6),
});
const tx = Transaction.updateContract(payload, Energy.create(10000n)).addMetadata({
  sender: AccountAddress.fromBase58(SELLER_B_ADDRESS),
  nonce: SequenceNumber.create(nonce),
  expiry: TransactionExpiry.futureMinutes(5),
});
const finalized = await Transaction.signAndFinalize(tx.build(), signers.sellerB.signer);
console.log('signed tx built OK (not submitted). version:', finalized.version, 'signatures present:', !!finalized.signature);
console.log('DRY RUN OK');
