// PayOnce backend — EasyPost TEST-mode capture tests (LIVE, test mode only).
// Runs the real CLI against the real EasyPost test-mode API (test key only,
// test addresses, watermarked TEST labels, no charge, no real shipment).
// If the EasyPost API is unreachable or the key is invalid these tests FAIL
// with the exact API error — nothing is faked.
// The key is loaded in-process only and never printed or written anywhere.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  getTracker,
  loadTestApiKeyFromEnvFile,
} from '../src/easypost/capture.mjs';

const execFileAsync = promisify(execFile);
const BACKEND_DIR = new URL('..', import.meta.url).pathname;
const CLI = join(BACKEND_DIR, 'src', 'easypost', 'cli.mjs');

const apiKey = loadTestApiKeyFromEnvFile();
const workDir = mkdtempSync(join(tmpdir(), 'payonce-easypost-'));
const firstOut = join(workDir, 'capture-1.json');
const secondOut = join(workDir, 'capture-2.json');
let first = null;

async function runCli(outPath) {
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [CLI, 'capture', '--out', outPath],
    { cwd: BACKEND_DIR, timeout: 120_000 },
  );
  return { stdout, stderr };
}

function assertNoKeyMaterial(text, where) {
  // The key itself, its public prefix, and distinctive slices of it must
  // never appear in any output file or stdout.
  assert.ok(!text.includes(apiKey), `${where} contains the full API key`);
  assert.ok(!text.includes('EZTK'), `${where} contains the EZTK key prefix`);
  for (const start of [4, 12, 20, 28, 36, 44]) {
    const slice = apiKey.slice(start, start + 12);
    if (slice.length >= 8) {
      assert.ok(
        !text.includes(slice),
        `${where} contains a slice of the API key`,
      );
    }
  }
}

test(
  'CLI runs live in test mode and produces evidence with test-mode markers and no key material',
  { timeout: 180_000 },
  async () => {
    const { stdout, stderr } = await runCli(firstOut);
    assert.equal(stderr, '', `CLI stderr should be empty, got: ${stderr}`);
    assertNoKeyMaterial(stdout, 'CLI stdout');
    assert.match(stdout, /mode:\s+test/, 'CLI summary must state test mode');

    const raw = readFileSync(firstOut, 'utf8');
    assertNoKeyMaterial(raw, 'evidence file');
    first = JSON.parse(raw);

    assert.equal(first.mode, 'test', 'evidence mode must be "test"');
    assert.equal(first.testModeAsserted, true, 'test mode must be asserted on the API responses');
    assert.equal(first.payable, 7);
    assert.equal(first.payment.token, 'EUDemo');
    assert.equal(first.payment.amount, '0.01');
    assert.match(first.contents, /TEST/, 'contents must be marked TEST');
    assert.match(first.shipmentId, /^shp_/, 'shipment id must start with shp_');
    assert.match(first.trackerId, /^trk_/, 'tracker id must start with trk_');
    assert.match(first.shipmentTrackerId, /^trk_/, 'shipment auto-tracker id must start with trk_');
    assert.equal(first.testTrackerCode, 'EZ4000000004', 'standalone tracker must use the documented EZ test code');
    assert.equal(first.trackerStatus, 'delivered', 'EZ4000000004 simulates delivered');
    assert.ok(first.trackingCode && first.trackingCode.length > 0, 'tracking code must be present');
    assert.match(first.labelUrl, /^https:\/\//, 'label URL must be an https URL');
    assert.equal(typeof first.shipmentStatus, 'string');
    assert.equal(typeof first.trackerStatus, 'string');
    assert.equal(typeof first.trackerRetrievedStatus, 'string');
    assert.ok(first.createdAt, 'createdAt must be present');
  },
);

test(
  'getTracker returns the tracker created by the CLI run',
  { timeout: 120_000 },
  async () => {
    assert.ok(first, 'first CLI run must have produced evidence');
    const current = await getTracker(apiKey, first.trackerId);
    assert.equal(current.trackerId, first.trackerId);
    // The standalone tracker uses the EZ test tracking number, not the
    // shipment's real-format tracking code (see testTrackerCode).
    assert.equal(current.trackingCode, first.testTrackerCode);
    assert.equal(current.status, first.trackerRetrievedStatus);
    assert.equal(current.testModeAsserted, true);
  },
);

test(
  'a second run creates a distinct shipment (no dedup assumption)',
  { timeout: 180_000 },
  async () => {
    const { stdout } = await runCli(secondOut);
    assertNoKeyMaterial(stdout, 'second CLI stdout');
    const raw = readFileSync(secondOut, 'utf8');
    assertNoKeyMaterial(raw, 'second evidence file');
    const second = JSON.parse(raw);
    assert.equal(second.mode, 'test');
    assert.equal(second.testModeAsserted, true);
    assert.notEqual(second.shipmentId, first.shipmentId, 'second run must create a new shipment');
    assert.notEqual(second.trackingCode, first.trackingCode, 'second run must get a new tracking code');
    // No trackerId distinctness assertion: both runs legitimately reuse the
    // same documented EZ test tracking number for the standalone tracker.
  },
);

// Best-effort cleanup of temp evidence files (they hold no secrets).
test('cleanup temp evidence files', () => {
  rmSync(workDir, { recursive: true, force: true });
});
