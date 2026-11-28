#!/usr/bin/env python3
"""Build PayOnce's agent cards for the official CIS-8004 registry (testnet).

Each card is written as plain A2A JSON, then the official registry MCP (build_agent_badge, keyless)
injects the Concordium Badge extension and the ERC-8004 registrations entry. The returned bytes are
written VERBATIM to frontend/public/.well-known/registry/<file> and their SHA-256 goes to plan.json;
api/scripts/registry-publish.mjs (PHASE=pin) pins exactly that hash on chain.

Files under .well-known/registry/ are immutable once pinned: a change means a new file name (v2, v3...)
and a new setAgentURI, otherwise the badge check fails. The test api/test/registry-cards.test.mjs
enforces that the served bytes match plan.json.

usage: python3 tools/registry/build_cards.py <check_payee_token_id>
"""
import hashlib, json, os, sys, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(ROOT, 'frontend/public/.well-known/registry')
SITE = 'https://payonce-tau.vercel.app'
API = 'https://payonce-api-n98a.onrender.com'
BASE = f'{SITE}/.well-known/registry'
OWNER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
BUYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs'
SELLER2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr'
BOOK = 'PayOnce payable book payable_registry_v3 at <13172,0> (testnet; a 90-second demo copy runs at <13173,0>)'
HONEST = 'Testnet only, no real-world value. Payee names on testnet are self-asserted mock identities; PayOnce labels its own stand-ins as such.'


def mcp(name, args):
    req = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': name, 'arguments': {'network': 'testnet', **args}}}
    r = json.load(urllib.request.urlopen(urllib.request.Request('https://agent-registry-mcp.concordium.com/mcp', data=json.dumps(req).encode(), headers={'content-type': 'application/json'}), timeout=60))
    if 'error' in r or r['result'].get('isError'):
        raise SystemExit(f'{name} failed: {r}')
    return json.loads(r['result']['content'][0]['text'])


def base(name, desc, file, skills, extra_services=()):
    return {
        'type': 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
        'name': name,
        'description': desc,
        'version': '3.0.0',
        'active': True,
        'documentationUrl': 'https://github.com/mohamedwael201193/payonce/blob/main/docs/REGISTRY.md',
        'provider': {'organization': 'PayOnce', 'url': SITE},
        'x402Support': True,
        'defaultInputModes': ['application/json'],
        'defaultOutputModes': ['application/json'],
        'capabilities': {'streaming': False, 'pushNotifications': False},
        'supportedInterfaces': [{'protocolBinding': 'HTTP+JSON', 'protocolVersion': '1.0', 'url': API}],
        'services': [
            {'name': 'A2A', 'version': '1.0', 'endpoint': f'{BASE}/{file}'},
            {'name': 'PayOnce API', 'version': '1.0', 'endpoint': API},
            {'name': 'MCP', 'version': '2025-06-18', 'endpoint': f'{API}/mcp'},
            *extra_services,
        ],
        'skills': skills,
    }


SK_CHECK = {'id': 'check-payee', 'name': 'Check a payee before paying', 'tags': ['verification-of-payee', 'payments', 'concordium', 'x402'],
            'description': 'Verification of Payee: compare the name an invoice, x402 offer or payment link gave with the proven legal name behind the account that would be paid. Answers MATCH (pay once), CLOSE_MATCH (a person decides), NO_MATCH (pay nothing) or UNVERIFIED (verification not possible: a person decides).'}

CARDS = [
    dict(token=1476, owner=OWNER, wallet=OWNER, file='payonce-seller.v3.json', card=base(
        'PayOnce Seller',
        f'PayOnce seller agent. It registers invoices as payables on the {BOOK}. Each payable pays out exactly once, and only to a payee account that bound itself with its own signature and passed a cooling-off hold; the contract never holds funds. Buyers call check_payee on this payee before paying. The payee bound here is a labelled testnet stand-in ("PayOnce Labs"). {HONEST}',
        'payonce-seller.v3.json',
        [{'id': 'register-payable', 'name': 'Register a payable', 'tags': ['invoice', 'payable', 'concordium'], 'description': 'Register an invoice on the v3 book: payee, amount, asset (CCD or a PLT such as EUDemo), due date and document hash.'},
         {'id': 'receive-payment-once', 'name': 'Receive payment exactly once', 'tags': ['payment', 'ccd', 'x402'], 'description': 'pay_ccd forwards the payment atomically to the bound payee; a second payment is refused on chain (reject -5).'},
         SK_CHECK])),
    dict(token=1488, owner=BUYER, wallet=BUYER, file='payonce-buyer.v3.json', card=base(
        'PayOnce Buyer',
        f'PayOnce buyer (payer) agent. Before every payment (invoice, x402 service or /p/<account> payment link) it calls check_payee and the official badge check on the seller agent. It pays once with pay_ccd on the {BOOK} only on MATCH; it never pays on NO_MATCH and asks its human on CLOSE_MATCH or UNVERIFIED. Its agentWallet is the account that actually pays, bound by that account\'s own signature. {HONEST}',
        'payonce-buyer.v3.json',
        [{'id': 'pay-invoice-once', 'name': 'Pay an invoice exactly once', 'tags': ['payment', 'ccd', 'x402'], 'description': 'check_payee, then pay_ccd once; the contract refuses a second payment and a payee that is not bound or not matured.'},
         SK_CHECK])),
    dict(token=1506, owner=SELLER2, wallet=SELLER2, file='payonce-seller2.v3.json', card=base(
        'PayOnce Seller 2',
        f'PayOnce second seller agent. It registers invoices as payables on the PayOnce books and receives exactly one payment per payable, only to the account recorded on chain. {HONEST}',
        'payonce-seller2.v3.json',
        [{'id': 'register-payable', 'name': 'Register a payable', 'tags': ['invoice', 'payable', 'concordium'], 'description': 'Register an invoice as an on-chain payable.'},
         {'id': 'receive-payment-once', 'name': 'Receive payment exactly once', 'tags': ['payment', 'ccd'], 'description': 'Accept one payment per payable; a second one is refused on chain.'}])),
]


def check_payee_card(token):
    return dict(token=token, owner=OWNER, wallet=OWNER, file='payonce-check-payee.v1.json', card=base(
        'PayOnce check_payee',
        f'Verification of Payee for AI agents on Concordium. Before an agent pays, ask who the account really is: MATCH (pay once), CLOSE_MATCH (a person decides), NO_MATCH (pay nothing) or UNVERIFIED (verification not possible: a person decides). Reads any x402 seller\'s payTo for free. Free to call: REST, hosted MCP and a GitHub Action. The chain does not verify names; check_payee does, from a zero-knowledge presentation checked with the node. {HONEST}',
        'payonce-check-payee.v1.json',
        [SK_CHECK,
         {'id': 'check-x402-seller', 'name': 'Check an x402 seller without paying', 'tags': ['x402', 'verification-of-payee'], 'description': 'Read a seller\'s 402 offer, then run check_payee on its payTo account.'},
         {'id': 'payee-card', 'name': 'Payee card', 'tags': ['payee', 'concordium'], 'description': 'GET /api/p/<account>: who an account is, what it bound, and whether it is payable today.'}],
        extra_services=[{'name': 'REST check_payee', 'version': '1.0', 'endpoint': f'{API}/api/check-payee'},
                        {'name': 'Package source (check-payee)', 'version': '0.1', 'endpoint': 'https://github.com/mohamedwael201193/payonce/tree/main/packages/check-payee'},
                        {'name': 'GitHub Action', 'version': '1', 'endpoint': 'https://github.com/mohamedwael201193/payonce/tree/main/packages/check-payee-action'}]))


def main():
    cards = list(CARDS)
    if len(sys.argv) > 1:
        cards.append(check_payee_card(int(sys.argv[1])))
    os.makedirs(OUT, exist_ok=True)
    plan = []
    for c in cards:
        r = mcp('build_agent_badge', {'card_json': json.dumps(c['card']), 'owner_account': c['owner'], 'token_id': c['token'], 'agent_wallet': c['wallet']})
        body = r['agent_card_json'].encode()
        sha = hashlib.sha256(body).hexdigest()
        assert sha == r['metadata_hash_hex'], (sha, r['metadata_hash_hex'])
        path = os.path.join(OUT, c['file'])
        if os.path.exists(path) and open(path, 'rb').read() != body:
            raise SystemExit(f'{c["file"]} exists with other bytes: pinned files are immutable, use a new name')
        open(path, 'wb').write(body)
        plan.append({'token': c['token'], 'token_address': r['token_address'], 'owner': c['owner'], 'wallet': c['wallet'], 'file': c['file'], 'uri': f'{BASE}/{c["file"]}', 'sha256': sha})
        print(c['token'], r['token_address'], c['file'], sha)
    json.dump(plan, open(os.path.join(ROOT, 'tools/registry/plan.json'), 'w'), indent=2)


if __name__ == '__main__':
    main()
