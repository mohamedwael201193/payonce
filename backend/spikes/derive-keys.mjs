// PayOnce backend — HD key derivation probe (READ-ONLY, no sends).
// Derives candidate account keys from the seed phrase (in-process only) and
// matches their PUBLIC keys against the verifyKeys the chain itself reports
// for the three known accounts. Prints MATCHES only — never any key material.
// If a derived signing key equals the env private key, that is reported as a
// boolean only. A match proves the derivation indices for that account.
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import { ConcordiumHdWallet } from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { AccountAddress, BlockHash } from '@concordium/web-sdk';
import { credentials } from '@grpc/grpc-js';
import { grpcClient, getBlockTime, getAccountInfo, tokenBalance, toJson } from '../src/chain.mjs';

const env = parse(readFileSync('/home/hatch/workspace/concordium-trusted-agents/.env', 'utf8'));
const seedPhrase = env.CONCORDIUM_WALLET_SEED_PHRASE;
const envPrivateKey = (env.CONCORDIUM_WALLET_PRIVATE_KEY ?? '').toLowerCase();
if (!seedPhrase) throw new Error('no seed phrase in env');

const ACCOUNTS = {
  owner: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
  sellerB: '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs',
  agentC3: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n',
};

const client = grpcClient();
const consensus = toJson(await client.getConsensusStatus());
const blockHash = consensus.lastFinalizedBlock;
const blockInfo = await getBlockTime(client, blockHash);
console.log('finalized block height:', blockInfo.height);

// Collect verifyKeys per account: { accountLabel: { verifyKeyHex: 'credIdx:keyIdx' } }
const verifyKeys = {};
for (const [label, address] of Object.entries(ACCOUNTS)) {
  const info = await getAccountInfo(client, address, blockHash);
  const creds = info.accountCredentials ?? {};
  const credList = Array.isArray(creds) ? creds : Object.values(creds);
  console.log(`${label} ${address.slice(0, 10)}… threshold=${info.accountThreshold} credentials=${credList.length} nonce=${info.accountNonce}`);
  verifyKeys[label] = {};
  credList.forEach((cred, ci) => {
    const keys = cred?.value?.contents?.credentialPublicKeys?.keys ?? cred?.credentialPublicKeys?.keys ?? {};
    for (const [ki, key] of Object.entries(keys)) {
      const vk = (key?.verifyKey ?? key ?? '').toString().toLowerCase();
      if (vk.length === 64) verifyKeys[label][vk] = `cred ${ci} key ${ki}`;
    }
  });
  console.log(`  verifyKeys collected: ${Object.keys(verifyKeys[label]).length}`);
}

const wallet = ConcordiumHdWallet.fromSeedPhrase(seedPhrase, 'Testnet');
let matches = 0;
for (const idp of [0]) {
  for (const identity of [0, 1]) {
    for (let counter = 0; counter <= 12; counter++) {
      let pub;
      try {
        pub = wallet.getAccountPublicKey(idp, identity, counter).toString('hex').toLowerCase();
      } catch {
        continue;
      }
      for (const [label, keys] of Object.entries(verifyKeys)) {
        if (keys[pub]) {
          const signing = wallet.getAccountSigningKey(idp, identity, counter).toString('hex').toLowerCase();
          const equalsEnvKey = signing === envPrivateKey;
          console.log(`MATCH idp=${idp} identity=${identity} counter=${counter} -> ${label} (${keys[pub]}) | signing key equals env private key: ${equalsEnvKey}`);
          matches++;
        }
      }
    }
  }
}
console.log(`total matches: ${matches}`);
if (matches === 0) console.log('NO MATCH — the seed phrase does not derive these accounts with idp 0, identity 0-1, counter 0-12.');
