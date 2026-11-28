"""Run the live PayOnce check_payee on every distinct testnet payee account of the registry (read-only). Mainnet accounts are
classified by identity-provider only (the live check_payee API is testnet-only)."""
import json,csv,time,urllib.request,urllib.parse,collections,os,concurrent.futures as cf,threading
API="https://payonce-api-n98a.onrender.com/api/vop/check"; SELLER="3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr"
cards=json.load(open("cards_testnet.json")); accts={}
for a in json.load(open("agents_testnet.json")):
    p=a.get("agent_wallet") or a["owner_account"]; c=cards.get(a.get("agent_uri") or "",{})
    e=accts.setdefault(p,{"name":"","agents":0}); e["agents"]+=1
    if not e["name"] and c.get("name"): e["name"]=c["name"]
CACHE="vop_testnet_cache.json"; cache=json.load(open(CACHE)) if os.path.exists(CACHE) else {}
lock=threading.Lock(); gate=threading.Semaphore(1); last=[0.0]
def one(p):
    if p in cache: return
    v=accts[p]; q=urllib.parse.urlencode({"seller":SELLER,"payee":p,"name":v["name"] or "unknown"}); d=None
    for t in range(6):
        with gate:  # global pace: <=20 req/min (API limit is 30/min/IP)
            w=3.0-(time.time()-last[0]); 
            if w>0: time.sleep(w)
            last[0]=time.time()
        try: d=json.loads(urllib.request.urlopen(API+"?"+q,timeout=90).read()); break
        except urllib.error.HTTPError as e:
            if e.code==429: time.sleep(20); continue
            d={"verdict":"ERROR","reasons":[f"http {e.code}"]}; break
        except Exception as e: time.sleep(4)
    d=d or {"verdict":"ERROR","reasons":["no answer"]}
    with lock:
        cache[p]={"network":"testnet","payee":p,"agents":v["agents"],"invoice_name_used":v["name"],"verdict":d.get("verdict"),"identity_kind":d.get("identity_kind"),
          "book_status":((d.get("subject") or {}).get("book") or {}).get("status"),"reason":(d.get("reasons") or [""])[0][:200],"evidence_hash":d.get("evidence_hash")}
        json.dump(cache,open(CACHE,"w")); print(len(cache),"/",len(accts),flush=True)
with cf.ThreadPoolExecutor(6) as ex: list(ex.map(one,sorted(accts)))
out=[cache[p] for p in sorted(accts)]
json.dump(out,open("vop_testnet_results.json","w"),indent=1)
with open("vop_testnet_results.csv","w",newline="") as f:
    w=csv.DictWriter(f,fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
print("done",collections.Counter(o["verdict"] for o in out))
