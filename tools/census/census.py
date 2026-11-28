"""PayOnce Verification-of-Payee census of the Concordium Agent Registry (read-only).

Inputs (produced by the sibling scripts, all public data):
  agents_{net}.json   - every CIS-8004 agent (dl_agents.py, via the official hosted MCP list_agents)
  cards_{net}.json    - each agent card fetched once + SHA-256 (fetch_cards.py)
  idp_cache.json      - identity provider behind each owner/payee account credential (idp_scrape.py, CCDExplorer)
  badge_official.json - official Concordium badge verdicts for every agent that passed the local pre-filter
Outputs: census_{net}.csv, summary.json
"""
import json, csv, hashlib, sys, os, time, urllib.request, collections
REG={"mainnet":(10082,0),"testnet":(12802,0)}
BUSINESS_IDP={"mainnet":{"Global FinReg"},"testnet":{"Global FinReg Testnet"}}
A='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
def leb(n):
    o=bytearray()
    while True:
        b=n&0x7f; n>>=7
        o.append(b|(0x80 if n else 0))
        if not n: return bytes(o)
def b58(b):
    n=int.from_bytes(b,'big'); s=''
    while n: n,r=divmod(n,58); s=A[r]+s
    return '1'*(len(b)-len(b.lstrip(b'\0')))+s
def token_address(net,tid):
    i,s=REG[net]; p=b'\x02'+leb(i)+leb(s)+int(tid).to_bytes(8,'little')
    return b58(p+hashlib.sha256(hashlib.sha256(p).digest()).digest()[:4])
assert token_address("testnet",1506)=="JyP9Y9nGU4KaM7DBDXRgm"

OFF="badge_official.json"
official=json.load(open(OFF)) if os.path.exists(OFF) else {}
def official_check(net,ta):
    k=f"{net}:{ta}"
    if k in official: return official[k]
    url=f"https://agent-registry-mcp.concordium.com/v1/check-badge/{ta}?network={net}"
    for i in range(4):
        try:
            d=json.loads(urllib.request.urlopen(url,timeout=90).read())
            ag=(d.get("agents") or [d])[0]
            with _lock:
                official[k]={"badge_valid":ag.get("badge_valid"),"checks":ag.get("checks"),"issues":[x.get("field") for x in ag.get("issues",[])]}
                json.dump(official,open(OFF,"w"))
            time.sleep(0.3); return official[k]
        except Exception as e:
            time.sleep(3*(i+1))
    return {"badge_valid":None,"error":"official check failed"}

idp=json.load(open("idp_cache.json"))
import concurrent.futures as cf, threading
_lock=threading.Lock()
def _prefilter(net,a,cards):
    c=cards.get(a.get("agent_uri") or "",{})
    return a["status"]=="Active" and c.get("status")==200 and c.get("sha256")==a.get("metadata_hash_hex") and bool(c.get("badge_ext") or c.get("legacy_concordium_block"))
_orig=official_check
def official_check(net,ta):
    with _lock:
        if f"{net}:{ta}" in official: return official[f"{net}:{ta}"]
    return _orig(net,ta)
for _net in ["mainnet","testnet"]:
    _ag=json.load(open(f"agents_{_net}.json")); _cards=json.load(open(f"cards_{_net}.json"))
    _todo=[token_address(_net,a["token_id"]) for a in _ag if _prefilter(_net,a,_cards) and f"{_net}:{token_address(_net,a['token_id'])}" not in official]
    print(_net,"official badge checks to run:",len(_todo),flush=True)
    with cf.ThreadPoolExecutor(12) as ex:
        for i,_ in enumerate(ex.map(lambda t:_orig(_net,t),_todo)):
            if i%100==0: print(" ",i,flush=True)
summary={}
for net in ["mainnet","testnet"]:
    agents=json.load(open(f"agents_{net}.json")); cards=json.load(open(f"cards_{net}.json"))
    rows=[]
    for a in agents:
        c=cards.get(a.get("agent_uri") or "",{})
        active=a["status"]=="Active"
        fetched=c.get("status")==200
        hash_ok=fetched and c.get("sha256")==a.get("metadata_hash_hex")
        badge_present=bool(c.get("badge_ext") or c.get("legacy_concordium_block"))
        pre=active and fetched and hash_ok and badge_present
        ta=token_address(net,a["token_id"])
        off=official_check(net,ta) if pre else {"badge_valid":False}
        wallet=a.get("agent_wallet")
        payee=wallet  # on-chain payment routing (CIS-8004 agentWallet); unset => no verifiable payee
        pi=idp.get(f"{net}:{payee}",{}) if payee else {}
        oi=idp.get(f"{net}:{a['owner_account']}",{})
        payee_business=bool(payee) and bool(set(pi.get("providers",[]))&BUSINESS_IDP[net])
        owner_business=bool(set(oi.get("providers",[]))&BUSINESS_IDP[net])
        vop_pass= bool(off.get("badge_valid")) and bool(payee) and payee_business
        rows.append({"network":net,"token_id":a["token_id"],"token_address":ta,"status":a["status"],
            "owner_account":a["owner_account"],"agent_wallet":wallet or "","agent_uri":a.get("agent_uri") or "",
            "card_http":c.get("status"),"card_hash_matches":hash_ok,"badge_present":badge_present,
            "badge_valid_official":off.get("badge_valid"),"owner_idp":"|".join(oi.get("providers",[])),
            "payee_idp":"|".join(pi.get("providers",[])),"payee_is_owner":bool(wallet) and wallet==a["owner_account"],
            "owner_business_id":owner_business,"payee_business_id":payee_business,
            "card_mentions_x402":bool(c.get("mentions_x402")),"card_mentions_payment":bool(c.get("mentions_payment")),
            "vop_pass_today":vop_pass})
    with open(f"census_{net}.csv","w",newline="") as f:
        w=csv.DictWriter(f,fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
    n=len(rows); cnt=lambda f: sum(1 for r in rows if f(r))
    summary[net]={
        "agents_total":n,"active":cnt(lambda r:r["status"]=="Active"),
        "card_fetch_200":cnt(lambda r:r["card_http"]==200),"card_hash_matches":cnt(lambda r:r["card_hash_matches"]),
        "badge_present":cnt(lambda r:r["badge_present"]),"badge_valid_official":cnt(lambda r:r["badge_valid_official"] is True),
        "agent_wallet_set":cnt(lambda r:bool(r["agent_wallet"])),
        "card_mentions_x402":cnt(lambda r:r["card_mentions_x402"]),"card_mentions_payment":cnt(lambda r:r["card_mentions_payment"]),
        "valid_badge_and_wallet":cnt(lambda r:r["badge_valid_official"] is True and bool(r["agent_wallet"])),
        "owner_business_id":cnt(lambda r:r["owner_business_id"]),"payee_business_id":cnt(lambda r:r["payee_business_id"]),
        "vop_pass_today":cnt(lambda r:r["vop_pass_today"]),
        "distinct_owners":len({r["owner_account"] for r in rows}),
        "distinct_owners_business_id":len({r["owner_account"] for r in rows if r["owner_business_id"]}),
        "owner_idp_breakdown_by_owner":collections.Counter(idp.get(f"{net}:{o}",{}).get("providers",["unresolved"])[0] if idp.get(f"{net}:{o}",{}).get("providers") else "unresolved" for o in {r["owner_account"] for r in rows}),
        "idp_unresolved_accounts":cnt(lambda r: r["owner_idp"]==""),
    }
summary["generated_at_utc"]=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime())
json.dump(summary,open("summary.json","w"),indent=1,default=dict)
print(json.dumps(summary,indent=1,default=dict))
