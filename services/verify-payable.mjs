// KEYLESS verifier for one payable: node verify-payable.mjs <payable_id> [paymentTxHash]
// Reads only public chain data: the registry's get_payable view, the payment transaction (by hash), the
// instance balance, the seller's CIS-8004 agent, and the invoice document (SHA-256 check).
// No .env, no seed, no keys are loaded. Prints PASS/FAIL per check; exit code 0 only if every check passes.
//   CCD rail: pass the pay_ccd transaction hash (the contract cannot store its own transaction hash).
//   PLT rail: the payment tx hash is read from the on-chain Paid status (confirm_plt recorded it).
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const deploy = JSON.parse(readFileSync(path.join(DIR, 'out', 'deploy.json'), 'utf8'));
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const REG = sdk.ContractAddress.create(deploy.instance.index, deploy.instance.subindex);
const RN = sdk.ContractName.fromStringUnchecked('payable_registry');
const id = process.argv[2];
const payTx = process.argv[3];
if (!id) { console.error('usage: node verify-payable.mjs <payable_id> [paymentTxHash]'); process.exit(2); }

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`); };
const tagOf = o => Object.keys(o)[0];
const micro = x => { if (x && typeof x === 'object') return BigInt(x.microCcdAmount ?? x.value); const t = String(x); return t.includes('.') ? BigInt(Math.round(Number(t) * 1e6)) : BigInt(t); };
const hex = x => (typeof x === 'string' ? x : Buffer.from(Array.from(x, Number)).toString('hex'));

async function getPayable(payableId) {
  const s = await client.getEmbeddedSchema(sdk.ModuleReference.fromHexString(deploy.moduleRef));
  const ep = sdk.EntrypointName.fromStringUnchecked('get_payable');
  const r = await client.invokeContract({ contract: REG, method: sdk.ReceiveName.fromStringUnchecked('payable_registry.get_payable'), parameter: sdk.serializeUpdateContractParameters(RN, ep, BigInt(payableId), s.buffer, s.version) });
  if (r.tag !== 'success') throw new Error('get_payable failed');
  return sdk.deserializeReceiveReturnValue(r.returnValue.buffer, s.buffer, RN, ep, s.version)?.Some?.[0] ?? null;
}

async function agentOf(token) {
  const MOD = '0e57473715d1c2a364fa626b8783688db32b7fac9d0e2fc97043da91e1a7d3eb'; // official CIS-8004 module
  const s = await client.getEmbeddedSchema(sdk.ModuleReference.fromHexString(MOD));
  const CN = sdk.ContractName.fromStringUnchecked('CIS-8004');
  const ep = sdk.EntrypointName.fromStringUnchecked('agentOf');
  const r = await client.invokeContract({ contract: sdk.ContractAddress.create(deploy.cis8004.index, deploy.cis8004.subindex), method: sdk.ReceiveName.fromStringUnchecked('CIS-8004.agentOf'), parameter: sdk.serializeUpdateContractParameters(CN, ep, token, s.buffer, s.version) });
  if (r.tag !== 'success') return null;
  return sdk.deserializeReceiveReturnValue(r.returnValue.buffer, s.buffer, CN, ep, s.version)?.Some?.[0] ?? null;
}

const p = await getPayable(id);
check('payable registered on-chain', !!p, `registry ${deploy.instance.index},${deploy.instance.subindex}`);
if (!p) process.exit(1);
const assetTag = tagOf(p.asset);
const assetName = assetTag === 'Plt' ? p.asset.Plt[0] : 'CCD';
console.log(`      seller ${p.seller}\n      payee  ${p.payee}\n      amount ${p.amount} (${assetName})\n      due    ${p.due}\n      status ${tagOf(p.status)}`);

// invoice document (evidence): SHA-256 of the exact document bytes
const docFile = path.join(DIR, 'out', `invoice-${id}.txt`);
if (existsSync(docFile)) {
  const h = createHash('sha256').update(readFileSync(docFile)).digest('hex');
  check('invoice document hash matches doc_hash on chain', h === hex(p.doc_hash), `sha256(${path.basename(docFile)}) = ${h.slice(0, 16)}...`);
} else {
  check('invoice document available for hash check', false, `missing ${path.basename(docFile)}`);
}

// the seller's agent must be Active and owned by the seller (checked at register/pay time; re-read now)
const agent = await agentOf(hex(p.agent_token));
check('seller agent Active and owned by seller (CIS-8004 agentOf, now)', !!agent && tagOf(agent.status) === 'Active' && agent.owner_account === p.seller, agent ? `owner ${agent.owner_account}` : 'no agent');

const instance = await client.getInstanceInfo(REG);
const regBal = BigInt(instance.amount.microCcdAmount ?? instance.amount);
check('registry holds zero CCD after all steps', regBal === 0n, `balance ${regBal}`);

const st = p.status;
const stTag = tagOf(st);
check(`status is Paid`, stTag === 'Paid', stTag);
if (stTag === 'Paid') {
  const payer = st.Paid.payer;
  const txHash = assetTag === 'Ccd' ? payTx : (st.Paid.tx_hash?.Some ? hex(st.Paid.tx_hash.Some[0]) : payTx);
  if (!txHash) { check('payment transaction hash supplied', false, 'CCD rail: pass the pay_ccd tx hash'); } else {
    const item = await client.getBlockItemStatus(sdk.TransactionHash.fromHexString(txHash));
    const sum = item.outcome?.summary ?? {};
    check('payment transaction finalized without reject', item.status === 'finalized' && !sum.rejectReason, `${txHash}`);
    if (assetTag === 'Ccd') {
      const ev = sum.events ?? [];
      const upd = ev.find(e => e.tag === 'Updated' && String(e.receiveName) === 'payable_registry.pay_ccd');
      check('transaction invoked payable_registry.pay_ccd on this registry', !!upd && upd.address?.index && String(upd.address.index) === String(deploy.instance.index));
      check('sender is the recorded payer', String(sum.sender) === payer, String(sum.sender));
      const transfers = ev.filter(e => e.tag === 'Transferred');
      const toPayee = transfers.filter(e => String(e.to) === p.payee);
      check('single transfer to payee of the stored amount', transfers.length === 1 && toPayee.length === 1 && micro(toPayee[0].amount) === BigInt(p.amount), `amount ${transfers.map(t => String(micro(t.amount))).join(',')} to ${transfers.map(t => String(t.to)).join(',')}`);
      check('no transfer from the registry to anyone else', transfers.every(t => String(t.to) === p.payee));
    } else {
      const tt = (sum.events ?? []).filter(e => e.tag === 'TokenTransfer');
      check('one TokenTransfer in the payment transaction', tt.length === 1, `${tt.length}`);
      if (tt.length === 1) {
        const e = tt[0];
        check('token is EUDemo', String(e.tokenId) === assetName);
        check('from the recorded payer', String(e.from?.address ?? e.from) === payer, String(e.from?.address ?? e.from));
        check('to the stored payee', String(e.to?.address ?? e.to) === p.payee);
        check('amount equals the stored amount', BigInt(e.amount.value) === BigInt(p.amount), String(e.amount.value));
        const expectMemo = hex(sdk.CborMemo.fromString(`payable:${id}`).content);
        check('memo is payable:<id>', hex(e.memo?.content ?? e.memo ?? '') === expectMemo, sdk.CborMemo.parse(e.memo).toString?.() ?? '');
      }
    }
  }
}
const passed = results.every(Boolean);
console.log(`\n${passed ? 'ALL CHECKS PASS' : 'SOME CHECKS FAILED'} (${results.filter(Boolean).length}/${results.length})`);
process.exit(passed ? 0 : 1);
