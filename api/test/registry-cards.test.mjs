// The agent cards pinned on the official CIS-8004 registry are immutable: the bytes in
// frontend/public/.well-known/registry/ must hash to tools/registry/plan.json (= the on-chain metadata_hash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = new URL('../../', import.meta.url);
const plan = JSON.parse(readFileSync(new URL('tools/registry/plan.json', root), 'utf8'));

test('every pinned registry card matches its pinned SHA-256', () => {
  assert.ok(plan.length >= 4);
  for (const p of plan) {
    const body = readFileSync(new URL(`frontend/public/.well-known/registry/${p.file}`, root));
    assert.equal(createHash('sha256').update(body).digest('hex'), p.sha256, p.file);
    const card = JSON.parse(body);
    const ext = card.capabilities.extensions.find((e) => e.uri === 'https://docs.concordium.com/a2a-extensions/concordium-badge/v1');
    assert.ok(ext, `${p.file} has the Concordium badge extension`);
    assert.ok(ext.params.tokenAddress.endsWith(p.token_address));
    assert.ok(ext.params.agentWallet.endsWith(p.wallet));
  }
});
