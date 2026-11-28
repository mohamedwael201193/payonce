// Entry point for the hosted prover. Config only from the environment:
//   PROVER_OPENINGS_JSON   the dob + nationality openings of the payer credential (secret)
//   PAYONCE_PROVER_TOKEN   bearer token the PayOnce API presents (secret)
//   PORT                   set by the platform
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';
import { createProverServer, loadOpenings } from './prover.mjs';

const held = loadOpenings(process.env.PROVER_OPENINGS_JSON ?? '');
const token = process.env.PAYONCE_PROVER_TOKEN ?? '';
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());

async function makePresentation(reqJson) {
  const { VerificationRequestV1, VerifiablePresentationV1, CredentialRegistrationId } = sdk;
  const request = VerificationRequestV1.fromJSON(reqJson);
  const sc = request.subjectClaims[0];
  const statements = VerifiablePresentationV1.noRevealRequestedStatements(sc.statements);
  const claims = [VerifiablePresentationV1.createAccountClaims(held.network, CredentialRegistrationId.fromHexString(held.credId), held.issuer, statements)];
  const inputs = [{ type: 'account', issuer: held.issuer, values: held.values, randomness: held.randomness }];
  const pres = await VerifiablePresentationV1.createFromAnchor(client, request, claims, inputs, []);
  return pres.toJSON();
}

const server = createProverServer({ held, token, makePresentation });
const port = Number(process.env.PORT || 8788);
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ listening: port, attributesHeld: Object.keys(held.values) })));
