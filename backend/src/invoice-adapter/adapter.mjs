// PayOnce backend — D5 invoice-text adapter (testnet only).
//
// D5 DECISION (plan): an LLM MAY read invoice TEXT to help a human draft or
// pre-fill an invoice (seller-side convenience only). It must be pluggable
// and OFF by default, and its output must NEVER flow into a payment decision.
//
// HARD BOUNDARIES — this module is deliberately isolated from the payment path:
//   * The payment path (src/verifier/checks.mjs CCD-12 / PLT-15, src/send.mjs,
//     spikes/live-e2e.mjs, src/cosigner/*) uses invoice doc BYTES and their
//     sha256 hash only. No LLM ever reads, parses, or decides anything there.
//   * Nothing in src/, spikes/ or test/ outside this directory imports this
//     module. src/invoice-adapter/guard.mjs enforces that statically
//     (assertNoLlmInPaymentPath); see test/invoice-adapter.test.mjs.
//   * An adapter returns EXTRACTED TEXT FIELDS ONLY — never a payment
//     decision, never a hash, never an approval. Its output is drafting help
//     for a human; the human (and the on-chain doc hash) remain authoritative.
//
// ENABLE / DISABLE MECHANISM (the only two ways to turn this on):
//   1. Explicit code call:  enableAdapter('scripted')   (or any registered name)
//   2. Environment:        PAYONCE_INVOICE_ADAPTER=<registered name>
//      e.g. PAYONCE_INVOICE_ADAPTER=scripted
//   Default is OFF: no adapter is enabled at import time, and with no env var
//   set parseInvoiceText() returns { disabled: true, ... } instead of parsing.
//   To turn it back off: disableAdapter() — and, if the env var was the
//   mechanism, unset PAYONCE_INVOICE_ADAPTER as well (the env var is re-read
//   on every call, so unsetting it disables the adapter immediately).
//   There is no config file, no auto-detection, and no other enable path.
//
// NO NETWORK, NO KEYS IN THIS FILE: ScriptedAdapter works fully offline with
// zero network and zero keys. LlmAdapter is a STUB — it never calls any API
// (see the integration-point comment in its parseInvoiceText).

// Message returned/thrown whenever no LLM provider is configured. The D5
// adapter is OFF by default; this exact sentence is what a caller gets.
export const DISABLED_MESSAGE =
  'no LLM provider configured — D5 adapter is OFF by default';

const ENV_VAR = 'PAYONCE_INVOICE_ADAPTER';

/**
 * InvoiceTextAdapter — the interface every adapter implements.
 *
 * Contract for parseInvoiceText(text):
 *   input:  invoice text (string)
 *   output: {
 *     fields:     { amount?, currency?, payee?, due?, invoiceId? },
 *                   // EXTRACTED TEXT ONLY. amount is the raw text token
 *                   // (e.g. "0.5"), never a number used for payment.
 *     confidence: number 0..1,
 *     warnings:   [string],   // e.g. "missing field: payee"
 *     source:     "scripted" | "llm:<model>" | "disabled",
 *     disabled?:  true        // present only when the adapter is OFF
 *   }
 *   NEVER in the output: a payment decision, a hash, an approval, a
 *   signature, or anything the payment path could consume. Adapters do not
 *   read chain state and do not know what is stored on chain.
 */
export class InvoiceTextAdapter {
  constructor(name) {
    this.name = name;
  }

  /** @throws {Error} subclasses must implement this. */
  parseInvoiceText(_text) {
    throw new Error(`InvoiceTextAdapter(${this.name}): parseInvoiceText not implemented`);
  }
}

/** True when `obj` satisfies the adapter contract (a parseInvoiceText fn). */
export function isInvoiceTextAdapter(obj) {
  return !!obj && typeof obj.parseInvoiceText === 'function';
}

// ---------------------------------------------------------------- registry --

const adapters = new Map();
let enabledName = null; // set ONLY by enableAdapter(); null = nothing enabled.

/** Register an adapter under `name`. Throws unless it satisfies the contract. */
export function registerAdapter(name, adapter) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('registerAdapter: name must be a non-empty string');
  }
  if (!isInvoiceTextAdapter(adapter)) {
    throw new Error(
      `registerAdapter(${name}): adapter must implement parseInvoiceText(text)`,
    );
  }
  adapters.set(name, adapter);
  return adapter;
}

/** Return the adapter registered under `name`. Throws when unknown. */
export function getAdapter(name) {
  if (!adapters.has(name)) {
    throw new Error(
      `getAdapter: no adapter registered under "${name}" (registered: ${listAdapters().join(', ') || 'none'})`,
    );
  }
  return adapters.get(name);
}

/** Names of all registered adapters (sorted). */
export function listAdapters() {
  return [...adapters.keys()].sort();
}

/** Name from the env var, but only when it names a REGISTERED adapter. */
function envEnabledName() {
  const name = process.env[ENV_VAR];
  if (typeof name === 'string' && name.trim() !== '' && adapters.has(name)) {
    return name;
  }
  return null;
}

/**
 * Enable one registered adapter. This is one of the two enable mechanisms
 * (the other is the PAYONCE_INVOICE_ADAPTER env var). Throws when unknown.
 */
export function enableAdapter(name) {
  const adapter = getAdapter(name); // throws when not registered
  enabledName = name;
  ADAPTER_ENABLED = true;
  return adapter;
}

/** Disable whatever was enabled via enableAdapter(). */
export function disableAdapter() {
  enabledName = null;
  ADAPTER_ENABLED = false;
}

/**
 * Name of the currently enabled adapter, or null when disabled.
 * Syncs the ADAPTER_ENABLED flag, so the env-var mechanism is reflected too.
 */
export function getEnabledAdapterName() {
  const name = enabledName ?? envEnabledName();
  ADAPTER_ENABLED = name !== null;
  return name;
}

/** The currently enabled adapter instance, or null when disabled. */
export function getEnabledAdapter() {
  const name = getEnabledAdapterName();
  return name ? adapters.get(name) : null;
}

/** True when an adapter is enabled (explicit call or env var). Default: false. */
export function isAdapterEnabled() {
  return getEnabledAdapterName() !== null;
}

/**
 * Global flag: true only while an adapter is enabled (explicit
 * enableAdapter() call or PAYONCE_INVOICE_ADAPTER env var naming a
 * registered adapter). Default false. It is a live ESM binding: reading it
 * after enableAdapter()/disableAdapter() — or after any call that resolves
 * the enabled adapter, e.g. isAdapterEnabled() / parseInvoiceText() — shows
 * the current value. Prefer isAdapterEnabled() for a fresh read.
 */
export let ADAPTER_ENABLED = false;

/**
 * Parse invoice text with the currently enabled adapter.
 * When disabled (the default) returns { disabled: true, ... } and parses
 * nothing. When enabled, delegates to that adapter and returns its result.
 * An explicit `adapterName` is honoured ONLY when it is the enabled adapter.
 */
export function parseInvoiceText(text, adapterName) {
  const enabled = getEnabledAdapterName();
  const wanted = adapterName ?? enabled;
  if (!wanted || wanted !== enabled) {
    return {
      disabled: true,
      fields: {},
      confidence: 0,
      warnings: [
        `${DISABLED_MESSAGE}. Call enableAdapter("<name>") or set ${ENV_VAR}=<name>.`,
      ],
      source: 'disabled',
    };
  }
  return adapters.get(wanted).parseInvoiceText(text);
}

// ---------------------------------------------------------- ScriptedAdapter --

/**
 * ScriptedAdapter — deterministic, regex-based extraction for the PayOnce
 * test-invoice format. Works offline, zero network, zero keys. This is the
 * default (and currently only usable) adapter.
 *
 * Recognised lines:
 *   "PAYONCE TEST INVOICE — payable N"  -> invoiceId "N"
 *   "Amount: X CCD" / "Amount: X EUDemo" -> amount "X", currency "CCD"|"EUDemo"
 *   "Payee: <base58>"                   -> payee "<base58>"
 *   "Due: <ISO-8601>"                   -> due "<ISO-8601>"
 *
 * confidence is 1.0 only when all five fields are found; otherwise it is
 * found/5 and every missing field is listed in warnings. The adapter reads
 * TEXT only — it never consults chain state, so a tampered amount line yields
 * the tampered amount (see test/invoice-adapter.test.mjs).
 */
export class ScriptedAdapter extends InvoiceTextAdapter {
  constructor() {
    super('scripted');
  }

  parseInvoiceText(text) {
    if (typeof text !== 'string') {
      throw new TypeError('ScriptedAdapter.parseInvoiceText: text must be a string');
    }
    const fields = {};
    const warnings = [];

    const idMatch = text.match(/payable\s+(\d+)/i);
    if (idMatch) fields.invoiceId = idMatch[1];

    const amountMatch = text.match(/Amount:\s*([0-9]+(?:[.,][0-9]+)?)\s*(CCD|EUDemo)/i);
    if (amountMatch) {
      fields.amount = amountMatch[1].replace(',', '.');
      fields.currency = amountMatch[2];
    }

    const payeeMatch = text.match(/Payee:\s*([1-9A-HJ-NP-Za-km-z]{30,})/);
    if (payeeMatch) fields.payee = payeeMatch[1];

    const dueMatch = text.match(/Due:\s*([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z)/);
    if (dueMatch) fields.due = dueMatch[1];

    const fieldNames = ['amount', 'currency', 'payee', 'due', 'invoiceId'];
    let found = 0;
    for (const name of fieldNames) {
      if (fields[name] !== undefined) found += 1;
      else warnings.push(`missing field: ${name}`);
    }
    const confidence = Math.round((found / fieldNames.length) * 100) / 100;

    return { fields, confidence, warnings, source: 'scripted' };
  }
}

// -------------------------------------------------------------- LlmAdapter --

/**
 * LlmAdapter — STUB for a future real LLM provider. It NEVER calls any API:
 * there is no fetch, no HTTP client, and no key handling beyond holding the
 * caller-supplied credential in a private field for the future integration.
 *
 * Construction requires explicit real credentials:
 *   new LlmAdapter({ provider: 'openai', apiKey: '<key>', model: 'gpt-…' })
 * Without all three it throws DISABLED_MESSAGE — the D5 adapter is OFF by
 * default and stays off until a human configures a provider explicitly.
 * Even WITH credentials, parseInvoiceText() throws a stub error: wiring a
 * live provider is a separate, explicitly authorised step (see below).
 * The apiKey is held in a private (#) field: it is never logged, never
 * returned, and never appears in JSON.stringify() output.
 */
export class LlmAdapter extends InvoiceTextAdapter {
  #apiKey;

  constructor({ provider, apiKey, model } = {}) {
    super('llm');
    const missing = [];
    if (typeof provider !== 'string' || provider.trim() === '') missing.push('provider');
    if (typeof apiKey !== 'string' || apiKey.trim() === '') missing.push('apiKey');
    if (typeof model !== 'string' || model.trim() === '') missing.push('model');
    if (missing.length > 0) {
      // No credentials, no adapter: D5 is OFF by default.
      throw new Error(
        `${DISABLED_MESSAGE} (LlmAdapter requires explicit { provider, apiKey, model }; missing: ${missing.join(', ')})`,
      );
    }
    this.provider = provider;
    this.model = model;
    this.#apiKey = apiKey;
    // source tag for any future output from this adapter:
    this.sourceTag = `llm:${model}`;
  }

  parseInvoiceText(_text) {
    if (!this.#apiKey) throw new Error(DISABLED_MESSAGE);
    // --- INTEGRATION POINT (stub: no live call is made here) ---------------
    // A real implementation would replace this throw with, in order:
    //   1. POST to the provider's chat-completions endpoint for
    //      this.provider / this.model, authenticating with this.#apiKey
    //      (header only; never log the key, never put it in the prompt).
    //   2. Prompt constrained to extract ONLY { amount, currency, payee,
    //      due, invoiceId } as JSON from the supplied invoice text — no
    //      decision, no hash, no approval language allowed in the prompt.
    //   3. Parse + validate the JSON against the same field schema the
    //      ScriptedAdapter returns, and return
    //      { fields, confidence, warnings, source: `llm:${this.model}` }.
    //   4. NEVER pass the result to src/verifier/, src/send.mjs, or any
    //      payment-path module; it is drafting help for a human only.
    // Until that step is explicitly authorised and implemented, this throws.
    throw new Error(
      'LlmAdapter is a stub: no live provider call is implemented. ' +
        `Configure a real ${this.provider}/${this.model} call at the integration point ` +
        'in LlmAdapter.parseInvoiceText (see code comments) — D5 adapter stays OFF until then.',
    );
  }
}

// Default registry state: only the offline scripted adapter is registered.
// It is registered but NOT enabled — enableAdapter('scripted') or
// PAYONCE_INVOICE_ADAPTER=scripted is still required before any use.
registerAdapter('scripted', new ScriptedAdapter());
