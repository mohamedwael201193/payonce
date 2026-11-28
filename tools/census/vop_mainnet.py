"""Run the live PayOnce check_payee in MAINNET mode (identity-only, read-only) on every distinct mainnet payee account of the
registry (payee = agentWallet, or the owner when none is set: the registry default). ~120 accounts. Paced <=20 req/min.
Output: vop_mainnet_results.{json,csv}; cached in vop_mainnet_cache.json (deleted by refresh.sh on the daily full run)."""
import json,csv,time,urllib.request,urllib.parse,collections,os
API=os.environ.get("PAYONCE_API","https://payonce-api-n98a.onrender.com")+"/api/vop/check"; SELLER="3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr"
cards=json.load(open("cards_mainnet.json")); accts={}
for a in json.load(open("agents_mainnet.json")):
    p=a.get("agent_wallet") or a["owner_account"]; c=cards.get(a.get("agent_uri") or "",{})
    e=accts.setdefault(p,{"name":"","agents":0}); e["agents"]+=1
    if not e["name"] and c.get("name"): e["name"]=str(c["name"])[:120]
CACHE="vop_mainnet_cache.json"; cache=json.load(open(CACHE)) if os.path.exists(CACHE) else {}
last=0.0
for i,(p,v) in enumerate(sorted(accts.items())):
    if p in cache: continue
    q=urllib.parse.urlencode({"network":"mainnet","seller":SELLER,"payee":p,"name":v["name"] or "Unnamed agent"})
    d=None
    for t in range(5):
        wait=3.2-(time.time()-last)
        if wait>0: time.sleep(wait)
        last=time.time()
        try: d=json.loads(urllib.request.urlopen(API+"?"+q,timeout=90).read()); break
        except Exception as e: time.sleep(5*(t+1))
    if not d: print("FAILED",p); continue
    s=d.get("subject") or {}
    cache[p]={"network":"mainnet","payee":p,"agents":v["agents"],"invoice_name_used":v["name"],"verdict":d.get("verdict"),"identity_kind":d.get("identity_kind"),
      "payable":d.get("payable"),"source":s.get("source"),"idps":"|".join(x["name"] for x in s.get("identity_providers",[])),"evidence_hash":d.get("evidence_hash")}
    json.dump(cache,open(CACHE,"w")); print(i,len(accts),d.get("verdict"),d.get("identity_kind"),s.get("source"),flush=True)
out=[cache[p] for p in sorted(accts) if p in cache]
json.dump(out,open("vop_mainnet_results.json","w"),indent=1)
with open("vop_mainnet_results.csv","w",newline="") as f:
    w=csv.DictWriter(f,fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
print(len(out),"/",len(accts),collections.Counter(r["verdict"] for r in out),collections.Counter(r["identity_kind"] for r in out))
