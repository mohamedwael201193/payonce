// PayOnce backend — co-signer key (in-memory only, never written to disk).
// The key is an ed25519 seed held ONLY in process memory. It is loaded from
// the COSIGNER_SIGNING_KEY environment variable at startup (32-byte hex seed)
// or generated ephemerally for tests. It is never logged, never serialized,
// and never leaves this module except as signatures.
// Production note: the real co-signer key lives in a KMS/HSM; this module is
// the lab stand-in with the same interface (sign a digest, return hex).
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

// PKCS#8 DER prefix for a raw ed25519 seed (RFC 8410).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export function privateKeyFromSeedHex(seedHex) {
  const seed = Buffer.from(seedHex, 'hex');
  if (seed.length !== 32) throw new Error('ed25519 seed must be 32 bytes');
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

export function publicKeyHex(privateKey) {
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' });
  return spki.subarray(spki.length - 32).toString('hex');
}

export function generateSigner() {
  const { privateKey } = generateKeyPairSync('ed25519');
  return { privateKey, publicKey: publicKeyHex(privateKey) };
}

export function signerFromSeedHex(seedHex) {
  const privateKey = privateKeyFromSeedHex(seedHex);
  return { privateKey, publicKey: publicKeyHex(privateKey) };
}

/** Sign a 32-byte digest hex. Returns the 64-byte signature hex. */
export function signDigest(signer, digestHex) {
  const digest = Buffer.from(digestHex, 'hex');
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  return sign(null, digest, signer.privateKey).toString('hex');
}

export function verifyDigest(publicKeyHexValue, digestHex, signatureHex) {
  const pubDer = Buffer.concat([
    Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(publicKeyHexValue, 'hex'),
  ]);
  const pub = createPublicKey({ key: pubDer, format: 'der', type: 'spki' });
  return verify(null, Buffer.from(digestHex, 'hex'), pub, Buffer.from(signatureHex, 'hex'));
}
