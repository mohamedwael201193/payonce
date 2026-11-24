// PayOnce backend — EasyPost TEST-mode capture evidence (testnet only).
// Capture evidence for a paid invoice: a test-mode shipment + tracker proving
// the shipping-evidence plumbing works. NOT a real shipment: no real goods,
// no real addresses, no money moves.
//
// IMPORTANT — package-name trap: the installed npm package named `easypost`
// (v0.1.1) is NOT the EasyPost API client; it is an unrelated "read POST
// data" helper (primaryobjects/easypost-lib). The real client is
// `@easypost/api`, which is NOT installed here and must not be installed by
// this task, so this module talks to the documented EasyPost REST API
// (https://api.easypost.com/v2) directly with Node's built-in fetch.
// Auth (docs.easypost.com/docs/authentication): HTTP Basic, API key as the
// username, blank password, over TLS. A test key can only create test
// objects; test labels are watermarked "TEST".
//
// Docs used: https://www.easypost.com/docs/api (Authentication page),
// EasyPost shipments + trackers API reference.
// Endpoints: POST /shipments, POST /shipments/:id/buy,
// POST /trackers, GET /trackers/:id.
//
// Security: the API key is ALWAYS passed in as an argument, loaded
// in-process by the caller/CLI. It is never stored in a file, never logged,
// never echoed, and never included in any returned object or error message.
import { readFileSync } from 'node:fs';

export const EASYPOST_BASE_URL = 'https://api.easypost.com/v2';

// Default location of the test key for the CLI. Override with the
// EASYPOST_ENV_FILE env var or the EASYPOST_TEST_API_KEY env var.
export const DEFAULT_ENV_FILE =
  '/home/hatch/workspace/concordium-trusted-agents/.env';

// EasyPost's documented example test addresses (docs.easypost.com), with
// obviously-fake TEST names. No real person, no real address.
export const TEST_FROM_ADDRESS = {
  name: 'TEST — PayOnce shipper (no real goods)',
  street1: '417 Montgomery Street',
  city: 'San Francisco',
  state: 'CA',
  zip: '94104',
  country: 'US',
  phone: '415-555-0100',
};

export const TEST_TO_ADDRESS = {
  name: 'TEST — PayOnce recipient (no real goods)',
  street1: '179 N Harbor Drive',
  city: 'Redondo Beach',
  state: 'CA',
  zip: '90277',
  country: 'US',
  phone: '310-555-0100',
};

// Parcel dimensions in inches, weight in ounces.
export const TEST_PARCEL = { length: 10, width: 8, height: 4, weight: 16 };

// PayOnce context for the capture evidence (sent only as the shipment
// reference string; the goods themselves are test items, see CONTENTS_NOTE).
export const PAYABLE_REFERENCE = 'PayOnce-payable-7-TEST';
export const CONTENTS_NOTE =
  'TEST — PayOnce capture evidence, no real goods (payable 7, EUDemo 0.01)';

// Test-mode tracker creation only accepts EasyPost's documented test
// tracking numbers: a bought shipment's real-format tracking code is
// rejected with HTTP 422 in test mode ("only test tracking numbers are
// valid"). Each EZ code simulates one tracker status. The shipment's own
// auto-created tracker (returned by the buy) is what tracks the shipment's
// real tracking code; a standalone tracker must use one of these codes.
export const TEST_TRACKING_CODES = {
  EZ1000000001: 'pre_transit',
  EZ2000000002: 'in_transit',
  EZ3000000003: 'out_for_delivery',
  EZ4000000004: 'delivered',
  EZ5000000005: 'return_to_sender',
  EZ6000000006: 'failure',
  EZ7000000007: 'unknown',
};
export const DEFAULT_TEST_TRACKING_CODE = 'EZ4000000004'; // simulates 'delivered'

/**
 * Load the EasyPost TEST key in-process from a dotenv-style file.
 * Reads EASYPOST_TEST_API_KEY, refuses anything that is not a test key
 * (test keys start with EZTK). Never logs or returns the value anywhere
 * except to the caller, in memory.
 */
export function loadTestApiKeyFromEnvFile(envFile = DEFAULT_ENV_FILE) {
  let text;
  try {
    text = readFileSync(envFile, 'utf8');
  } catch (err) {
    throw new Error(
      `cannot read EasyPost env file ${envFile}: ${err.message}`,
    );
  }
  const match = text.match(/^EASYPOST_TEST_API_KEY=(.*)$/m);
  const key = match ? match[1].trim().replace(/^["']|["']$/g, '') : '';
  if (!key) {
    throw new Error(
      `EASYPOST_TEST_API_KEY not found in ${envFile}`,
    );
  }
  if (!key.startsWith('EZTK')) {
    throw new Error(
      'refusing to use a non-test EasyPost key (test keys start with EZTK)',
    );
  }
  return key;
}

/** One authenticated EasyPost REST call. Throws on HTTP error, never echoing the key. */
async function apiCall(apiKey, method, path, body) {
  if (!apiKey || typeof apiKey !== 'string') {
    throw new Error('EasyPost API key is required (pass it as an argument)');
  }
  const res = await fetch(`${EASYPOST_BASE_URL}${path}`, {
    method,
    headers: {
      // HTTP Basic auth: API key as username, blank password.
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Non-JSON error body; fall through to the status check below.
  }
  if (!res.ok) {
    const detail =
      data?.error?.message ||
      (Array.isArray(data?.error?.errors)
        ? data.error.errors.join('; ')
        : '') ||
      data?.error?.code ||
      res.statusText;
    throw new Error(
      `EasyPost ${method} ${path} failed: HTTP ${res.status} ${detail}`,
    );
  }
  return data;
}

/**
 * Assert an EasyPost object is a test-mode object. EasyPost objects carry a
 * `mode` field; a test key can only create test objects, so `mode` must be
 * "test" when the field is present. Returns true when the assertion holds.
 * The `mode` value is also returned on every result so evidence files can
 * record it.
 */
export function assertTestMode(obj, kind) {
  if (obj && typeof obj.mode === 'string' && obj.mode !== 'test') {
    throw new Error(
      `refusing non-test EasyPost ${kind}: mode is "${obj.mode}", expected "test"`,
    );
  }
  return obj?.mode === 'test';
}

/**
 * Create one TEST-mode shipment and buy its cheapest rate, producing a test
 * label (watermarked "TEST", no charge with a test key) and a tracking code.
 * Defaults to EasyPost's documented test addresses + a test parcel.
 * Returns { shipmentId, trackingCode, labelUrl, status, mode,
 * testModeAsserted, carrier, service, rate, rateCurrency, createdAt,
 * trackerId, trackerStatus }.
 */
export async function createTestShipment(
  apiKey,
  { to = TEST_TO_ADDRESS, from = TEST_FROM_ADDRESS, parcel = TEST_PARCEL } = {},
) {
  const created = await apiCall(apiKey, 'POST', '/shipments', {
    shipment: {
      to_address: to,
      from_address: from,
      parcel,
      reference: PAYABLE_REFERENCE,
    },
  });
  assertTestMode(created, 'shipment');
  if (!created.id || !created.id.startsWith('shp_')) {
    throw new Error(
      `unexpected shipment response: no shp_ id (status ${created.status ?? 'unknown'})`,
    );
  }
  const rates = Array.isArray(created.rates) ? created.rates : [];
  if (rates.length === 0) {
    const messages = (created.messages || [])
      .map((m) => m.message || m.carrier || '')
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `no rates returned for test shipment ${created.id}` +
        (messages ? `: ${messages}` : ''),
    );
  }
  // Cheapest rate wins; deterministic tie-break on carrier+service.
  const cheapest = [...rates].sort(
    (a, b) =>
      Number(a.rate) - Number(b.rate) ||
      `${a.carrier}${a.service}`.localeCompare(`${b.carrier}${b.service}`),
  )[0];

  const bought = await apiCall(
    apiKey,
    'POST',
    `/shipments/${created.id}/buy`,
    { rate: { id: cheapest.id } },
  );
  const testModeAsserted = assertTestMode(bought, 'shipment');
  const labelUrl = bought.postage_label?.label_url;
  if (!labelUrl) {
    throw new Error(
      `bought test shipment ${bought.id} but no postage_label.label_url came back`,
    );
  }
  if (!bought.tracking_code) {
    throw new Error(
      `bought test shipment ${bought.id} but no tracking_code came back`,
    );
  }
  return {
    shipmentId: bought.id,
    trackingCode: bought.tracking_code,
    labelUrl,
    labelPdfUrl: bought.postage_label?.label_pdf_url ?? null,
    status: bought.status ?? null,
    mode: bought.mode ?? null,
    testModeAsserted,
    carrier: bought.selected_rate?.carrier ?? cheapest.carrier,
    service: bought.selected_rate?.service ?? cheapest.service,
    rate: bought.selected_rate?.rate ?? cheapest.rate,
    rateCurrency: bought.selected_rate?.currency ?? cheapest.currency ?? 'USD',
    createdAt: bought.created_at ?? null,
    trackerId: bought.tracker?.id ?? null,
    trackerStatus: bought.tracker?.status ?? null,
  };
}

/**
 * Create a standalone tracker for a tracking code.
 * TEST-MODE LIMIT: only EasyPost's documented EZ test tracking numbers are
 * accepted (see TEST_TRACKING_CODES); a real-format tracking code is
 * rejected with HTTP 422 in test mode. Pass one of the EZ codes here; the
 * shipment's own auto-created tracker (from the buy) is what tracks the
 * shipment's real tracking code.
 * Returns { trackerId, status, trackingCode, carrier, mode,
 * testModeAsserted, createdAt, publicUrl }.
 */
export async function createTestTracker(
  apiKey,
  { trackingCode, carrier } = {},
) {
  if (!trackingCode) throw new Error('createTestTracker: trackingCode is required');
  if (!carrier) throw new Error('createTestTracker: carrier is required');
  const tracker = await apiCall(apiKey, 'POST', '/trackers', {
    tracking_code: trackingCode,
    carrier,
  });
  const testModeAsserted = assertTestMode(tracker, 'tracker');
  if (!tracker.id || !tracker.id.startsWith('trk_')) {
    throw new Error('unexpected tracker response: no trk_ id');
  }
  return {
    trackerId: tracker.id,
    status: tracker.status ?? null,
    trackingCode: tracker.tracking_code ?? trackingCode,
    carrier: tracker.carrier ?? carrier,
    mode: tracker.mode ?? null,
    testModeAsserted,
    createdAt: tracker.created_at ?? null,
    publicUrl: tracker.public_url ?? null,
  };
}

/**
 * Fetch the current state of a tracker by id.
 * Returns { trackerId, status, trackingCode, carrier, mode,
 * testModeAsserted, createdAt, estDeliveryDate, publicUrl }.
 */
export async function getTracker(apiKey, trackerId) {
  if (!trackerId) throw new Error('getTracker: trackerId is required');
  const tracker = await apiCall(
    apiKey,
    'GET',
    `/trackers/${encodeURIComponent(trackerId)}`,
  );
  const testModeAsserted = assertTestMode(tracker, 'tracker');
  return {
    trackerId: tracker.id,
    status: tracker.status ?? null,
    trackingCode: tracker.tracking_code ?? null,
    carrier: tracker.carrier ?? null,
    mode: tracker.mode ?? null,
    testModeAsserted,
    createdAt: tracker.created_at ?? null,
    estDeliveryDate: tracker.est_delivery_date ?? null,
    publicUrl: tracker.public_url ?? null,
  };
}
