// Contract parameters for /api/relay/prepare, which takes the parameter as hex.
// accept_payee: AcceptPayeeParam { seller: AccountAddress (32 bytes), version: u32 LE, proof_anchor: [u8; 32] }
// (contracts/payable_registry_v3/src/lib.rs).
import { AccountAddress } from '@concordium/web-sdk'

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('')

export function acceptPayeeParamHex(seller: string, version: number, proofAnchorHex: string): string {
  if (!/^[0-9a-f]{64}$/i.test(proofAnchorHex)) throw new Error('proof_anchor must be 32 bytes of hex')
  if (!Number.isInteger(version) || version < 0 || version > 0xffffffff) throw new Error('version must be a u32')
  const v = new Uint8Array(4)
  new DataView(v.buffer).setUint32(0, version, true)
  return hex(AccountAddress.fromBase58(seller).decodedAddress) + hex(v) + proofAnchorHex.toLowerCase()
}
