// PayOnce backend — EasyPost TEST-mode capture CLI.
// Usage: node src/easypost/cli.mjs capture --out <path>
// Loads the EasyPost TEST key in-process (EASYPOST_TEST_API_KEY env var, or
// EASYPOST_ENV_FILE / the default .env path), creates one test shipment +
// one tracker for it, and writes ONLY non-secret evidence to <path>.
// Prints a short summary. Exits non-zero on any API failure.
// The key value is never printed, logged, or written to any file.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  CONTENTS_NOTE,
  DEFAULT_ENV_FILE,
  DEFAULT_TEST_TRACKING_CODE,
  PAYABLE_REFERENCE,
  TEST_TRACKING_CODES,
  createTestShipment,
  createTestTracker,
  getTracker,
  loadTestApiKeyFromEnvFile,
} from './capture.mjs';

function usage() {
  return 'usage: node src/easypost/cli.mjs capture --out <path>';
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'capture') {
    throw new Error(`unknown command ${JSON.stringify(command ?? '')}\n${usage()}`);
  }
  let out = null;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--out' && rest[i + 1]) {
      out = rest[i + 1];
      i += 1;
    } else if (rest[i].startsWith('--out=')) {
      out = rest[i].slice('--out='.length);
    } else {
      throw new Error(`unknown argument ${JSON.stringify(rest[i])}\n${usage()}`);
    }
  }
  if (!out) throw new Error(`missing --out <path>\n${usage()}`);
  return { out };
}

function loadTestApiKey() {
  if (process.env.EASYPOST_TEST_API_KEY) {
    const key = process.env.EASYPOST_TEST_API_KEY.trim();
    if (!key.startsWith('EZTK')) {
      throw new Error(
        'refusing to use a non-test EasyPost key (test keys start with EZTK)',
      );
    }
    return key;
  }
  const envFile = process.env.EASYPOST_ENV_FILE || DEFAULT_ENV_FILE;
  return loadTestApiKeyFromEnvFile(envFile);
}

async function main() {
  const { out } = parseArgs(process.argv.slice(2));
  const apiKey = loadTestApiKey();

  const shipment = await createTestShipment(apiKey);
  // Standalone tracker creation in test mode only accepts EasyPost's
  // documented EZ test tracking numbers, so the standalone tracker uses
  // DEFAULT_TEST_TRACKING_CODE (simulated status per TEST_TRACKING_CODES).
  // The shipment's real-format tracking code is tracked by the auto-created
  // tracker returned with the bought shipment (shipment.trackerId).
  const tracker = await createTestTracker(apiKey, {
    trackingCode: DEFAULT_TEST_TRACKING_CODE,
    carrier: shipment.carrier,
  });
  const current = await getTracker(apiKey, tracker.trackerId);
  const shipmentTracker = shipment.trackerId
    ? await getTracker(apiKey, shipment.trackerId)
    : null;

  // Non-secret evidence ONLY. No key material anywhere in this object.
  const evidence = {
    mode: 'test',
    tool: 'payonce-easypost-capture',
    payable: 7,
    payment: { token: 'EUDemo', amount: '0.01' },
    contents: CONTENTS_NOTE,
    reference: PAYABLE_REFERENCE,
    shipmentId: shipment.shipmentId,
    trackingCode: shipment.trackingCode,
    labelUrl: shipment.labelUrl,
    labelPdfUrl: shipment.labelPdfUrl,
    shipmentStatus: shipment.status,
    carrier: shipment.carrier,
    service: shipment.service,
    rate: shipment.rate,
    rateCurrency: shipment.rateCurrency,
    shipmentTrackerId: shipment.trackerId,
    shipmentTrackerStatus: shipment.trackerStatus,
    shipmentTrackerRetrievedStatus: shipmentTracker?.status ?? null,
    testTrackerCode: DEFAULT_TEST_TRACKING_CODE,
    testTrackerSimulatedStatus: TEST_TRACKING_CODES[DEFAULT_TEST_TRACKING_CODE],
    testTrackerNote:
      'Test mode only accepts EasyPost EZ test tracking numbers for standalone trackers; the shipment\'s real-format tracking code is tracked by its auto-created tracker (shipmentTrackerId).',
    trackerId: tracker.trackerId,
    trackerStatus: tracker.status,
    trackerRetrievedStatus: current.status,
    trackerPublicUrl: current.publicUrl,
    estDeliveryDate: current.estDeliveryDate,
    createdAt: shipment.createdAt,
    testModeAsserted:
      shipment.testModeAsserted &&
      tracker.testModeAsserted &&
      current.testModeAsserted &&
      (shipmentTracker ? shipmentTracker.testModeAsserted : true),
    generatedAt: new Date().toISOString(),
  };

  const outPath = resolve(out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');

  console.log('EasyPost TEST capture evidence (no real shipment, no real goods):');
  console.log(`  mode:            test (asserted on shipment + tracker)`);
  console.log(`  payable:         7 (EUDemo 0.01)`);
  console.log(`  shipment:        ${shipment.shipmentId} [${shipment.status}]`);
  console.log(`  tracking code:   ${shipment.trackingCode} (${shipment.carrier} ${shipment.service})`);
  console.log(`  label (TEST):    ${shipment.labelUrl}`);
  console.log(`  ship tracker:    ${shipment.trackerId} [${shipmentTracker?.status ?? shipment.trackerStatus}] (re-read)`);
  console.log(`  test tracker:    ${tracker.trackerId} [${tracker.status}] (EZ test code ${DEFAULT_TEST_TRACKING_CODE})`);
  console.log(`  tracker re-read: ${current.trackerId} [${current.status}]`);
  console.log(`  evidence file:   ${outPath}`);
}

try {
  await main();
} catch (err) {
  console.error(`EasyPost capture failed: ${err.message}`);
  process.exit(1);
}
