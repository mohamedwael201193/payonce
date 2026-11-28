// POST /api/invoices/parse { text } -> { payee_name, account, amount_ccd, reference, warnings }
// A plain, deterministic parser (no model): it pulls the payee name, the account, the amount and a reference out of
// invoice text so the check can run. What it returns is a CLAIM from the text, never an instruction. check_payee decides.
const ADDR = /\b[1-9A-HJ-NP-Za-km-z]{50}\b/g;
const NAME_LABELS = /^(?:payee|pay\s*to|beneficiary|account\s*name|supplier|vendor|seller|from|issued\s*by|bill\s*from|company|name)\s*[:\-–]\s*(.+)$/i;
const REF_LABELS = /^(?:invoice\s*(?:no\.?|number|ref(?:erence)?)|reference|ref|inv\.?)\s*[:\-–#]\s*([A-Za-z0-9][A-Za-z0-9\-_/]{1,39})\b|^invoice\s*#\s*([A-Za-z0-9][A-Za-z0-9\-_/]{0,39})\b/i;
const AMOUNT_LINE = /(?:total(?:\s*due)?|amount(?:\s*due)?|balance(?:\s*due)?|payable|please\s*pay|due)\b[^0-9\n]{0,24}([0-9][0-9,]*(?:\.[0-9]{1,6})?)\s*(?:CCD|ccd)?/i;
const CCD_ANY = /([0-9][0-9,]*(?:\.[0-9]{1,6})?)\s*CCD\b/i;

export class ParseError extends Error { constructor(message) { super(message); this.status = 400; this.code = 'bad_invoice_text'; } }

const clean = (s, n = 120) => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (s) => { const v = String(s).replace(/,/g, ''); if (!/^\d+(\.\d{1,6})?$/.test(v)) return null; return v.includes('.') ? v.replace(/\.?0+$/, '') || '0' : v; };

export function parseInvoice(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ParseError('text is required.');
  if (text.length > 20_000) throw new ParseError('The invoice text is too long (20,000 characters at most).');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const warnings = [];

  const accounts = [...new Set(text.match(ADDR) ?? [])];
  if (accounts.length > 1) warnings.push(`The text names ${accounts.length} different accounts; the first is used. Payment details in a message are never trusted: check_payee decides.`);
  if (!accounts.length) warnings.push('No Concordium account address found in the text.');

  let name = null;
  for (const l of lines) { const m = NAME_LABELS.exec(l); if (m) { name = clean(m[1].replace(ADDR, '').replace(/[,;|]+\s*$/, '')); if (name) break; } }
  if (!name) {
    const head = lines.find((l) => !/\d{3,}/.test(l) && !/^(invoice|bill|receipt|tax|date|due|total|amount|page)\b/i.test(l) && l.length >= 3 && l.length <= 80);
    if (head) { name = clean(head); warnings.push('The payee name was taken from the first line, not from a labelled field.'); }
  }
  if (!name) warnings.push('No payee name found.');

  let amount = null;
  for (const l of lines) { const m = AMOUNT_LINE.exec(l.replace(ADDR, ' ')); if (m && num(m[1])) { amount = num(m[1]); break; } }
  if (amount === null) { const m = CCD_ANY.exec(text); if (m) amount = num(m[1]); }
  if (amount === null) warnings.push('No amount found.');

  let reference = null;
  for (const l of lines) { const m = REF_LABELS.exec(l); if (m) { reference = clean(m[1] ?? m[2], 40); break; } }

  // A line that talks to an AI agent is reported, not obeyed.
  if (/\b(ignore|disregard)\b[^.\n]{0,40}\b(instructions|rules|checks?)\b|\b(ai|agent|assistant)\b[^.\n]{0,60}\b(must|should|please)\b[^.\n]{0,60}\b(pay|transfer|send)\b|bank details (?:have )?changed/i.test(text)) {
    warnings.push('The text contains wording aimed at an AI agent or announcing changed payment details. It is ignored; the account is checked, not trusted.');
  }
  return { payee_name: name ?? '', account: accounts[0] ?? '', amount_ccd: amount ?? '', reference, warnings };
}
