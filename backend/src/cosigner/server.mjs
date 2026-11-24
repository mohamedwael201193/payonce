// PayOnce backend — co-signer HTTP service (lab).
//   GET  /health  -> { ok, publicKey, ledgerPath, signerConfigured }
//   POST /decide  -> { decision, code, reasons }            (no key needed)
//   POST /sign    -> decide; on SIGN: write the ledger entry FIRST, then
//                    sign the digest; on ledger failure refuse (C-35) and
//                    return NO signature. { snapshot, request, digest, txHash? }
//   GET  /ledger  -> the ledger entries (read-only view)
// The signing key is in-memory only (see signer.mjs). No secrets are logged.
// Start:  node src/cosigner/server.mjs  (env: COSIGNER_SIGNING_KEY hex seed,
// COSIGNER_LEDGER path, PORT default 8787). Without a key, /sign is disabled.
import { createServer } from 'node:http';
import { decide } from './decide.mjs';
import { loadLedger, appendEntry, ledgerForDecide } from './ledger.mjs';
import { signerFromSeedHex, signDigest } from './signer.mjs';

export function createCosignerServer({ signer = null, ledgerPath }) {
  const server = createServer(async (req, res) => {
    const send = (code, body) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const readBody = () =>
      new Promise((resolve, reject) => {
        let data = '';
        req.on('data', (c) => (data += c));
        req.on('end', () => {
          try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
        });
      });

    try {
      if (req.method === 'GET' && req.url === '/health') {
        return send(200, { ok: true, signerConfigured: !!signer, publicKey: signer?.publicKey ?? null, ledgerPath });
      }
      if (req.method === 'GET' && req.url === '/ledger') {
        return send(200, loadLedger(ledgerPath));
      }
      if (req.method === 'POST' && req.url === '/decide') {
        const { snapshot, request } = await readBody();
        const payableKey = `${snapshot.payable.seller ?? ''}:${snapshot.payable.id}`;
        return send(200, decide(snapshot, request, ledgerForDecide(loadLedger(ledgerPath), payableKey)));
      }
      if (req.method === 'POST' && req.url === '/sign') {
        if (!signer) return send(503, { decision: 'REFUSE', code: 'no-signer', reasons: ['no signing key configured'] });
        const { snapshot, request, digest, txHash } = await readBody();
        const payableKey = `${snapshot.payable.seller ?? ''}:${snapshot.payable.id}`;
        const ledger = ledgerForDecide(loadLedger(ledgerPath), payableKey);
        const decision = decide(snapshot, request, ledger);
        if (decision.decision !== 'SIGN') return send(403, decision);
        const entry = {
          ts: snapshot.slotTime,
          blockHash: snapshot.blockHash,
          kind: request.kind,
          payableKey,
          digest,
          txHash: txHash ?? null,
          headerExpiry: request.headerExpirySeconds ?? null,
          reservationExpires: snapshot.payable.expiresMs ?? null,
          decision: 'SIGN',
          state: request.kind === 'transfer' ? 'unresolved' : 'recorded',
        };
        try {
          appendEntry(ledgerPath, entry); // C-35: ledger first, signature second.
        } catch (e) {
          return send(403, { decision: 'REFUSE', code: 'ledger-write-failed', reasons: [`ledger append failed: ${e.message}; no signature issued`] });
        }
        const signature = signDigest(signer, digest);
        return send(200, { decision: 'SIGN', code: null, reasons: [], signature, publicKey: signer.publicKey, entry });
      }
      return send(404, { error: 'not found' });
    } catch (e) {
      return send(400, { error: e.message });
    }
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ledgerPath = process.env.COSIGNER_LEDGER ?? new URL('../../data/cosigner-ledger.jsonl', import.meta.url).pathname;
  const seed = process.env.COSIGNER_SIGNING_KEY;
  const signer = seed ? signerFromSeedHex(seed) : null;
  if (!signer) console.error('WARNING: no COSIGNER_SIGNING_KEY set — /sign disabled, /decide still works.');
  const port = Number(process.env.PORT ?? 8787);
  const server = createCosignerServer({ signer, ledgerPath });
  server.listen(port, () => console.log(`co-signer listening on :${port} (ledger ${ledgerPath})`));
}
