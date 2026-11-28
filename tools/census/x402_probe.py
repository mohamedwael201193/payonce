"""Find live x402 sellers advertised by registry agents (+ field repos) and read their 402 challenge (GET only, NO payment).
Output x402_sellers.json: one row per endpoint with status, network, payTo, asset, amount."""
import json,re,base64,urllib.request,urllib.error,concurrent.futures as cf,collections,ssl,sys,glob,os
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
cands={}  # url -> source
def add(u,src):
    if isinstance(u,str) and u.startswith("http") and len(u)<300: cands.setdefault(u.split("#")[0],src)
def load(item):
    n,uri=item
    try:
        card=json.loads(urllib.request.urlopen(urllib.request.Request(uri,headers={"user-agent":"payonce-census/1.0"}),timeout=8,context=ctx).read(2_000_000))
    except Exception: return n,uri,None
    return n,uri,card
todo=[(n,u) for n in ["mainnet","testnet"] for u,r in json.load(open(f"cards_{n}.json")).items() if r.get("status")==200 and r.get("mentions_x402")]
with cf.ThreadPoolExecutor(48) as ex: loaded=list(ex.map(load,todo))
for n,uri,card in loaded:
    if not isinstance(card,dict): continue
    s=json.dumps(card).lower()
    if '"x402support": true' not in s and not re.search(r'"name": ?"x402"',s) and "x402" not in [str(x.get("name","")).lower() for x in card.get("services",[]) if isinstance(x,dict)]: continue
    for sv in card.get("services",[]) or []:
        if isinstance(sv,dict) and ("x402" in json.dumps(sv).lower()): add(sv.get("endpoint") or sv.get("url"),f"card:{n}:{uri}")
    for k in ("x402","x402Endpoint","paymentEndpoint"):
        if isinstance(card.get(k),str): add(card[k],f"card:{n}:{uri}")
# field repos (competitor/other-team x402 endpoints named in their READMEs)
for u in open("x402_field_urls.txt").read().split() if os.path.exists("x402_field_urls.txt") else []: add(u,"field")
print("candidates",len(cands),flush=True)
def probe(u):
    rec={"url":u,"source":cands[u]}
    body=b""
    for m in ("GET","POST"):
        try:
            req=urllib.request.Request(u,method=m,data=(b"{}" if m=="POST" else None),headers={"user-agent":"payonce-census/1.0","accept":"application/json","content-type":"application/json"})
            r=urllib.request.urlopen(req,timeout=10,context=ctx); rec["status"]=r.status; rec["headers"]={}; body=r.read(200000); rec["method"]=m
        except urllib.error.HTTPError as e:
            rec["status"]=e.code; body=e.read(200000); rec["method"]=m; hd={k.lower():v for k,v in e.headers.items()}
            rec["headers"]={k:v for k,v in hd.items() if "payment" in k or k=="www-authenticate"}
        except Exception as e:
            rec["status"]=None; rec["error"]=type(e).__name__; return rec
        if rec["status"]==402: break
    if rec["status"]==402:
        ch=None
        try: ch=json.loads(body)
        except Exception: pass
        if not ch or not isinstance(ch,dict) or not ch.get("accepts"):
            for k,v in rec["headers"].items():
                if "payment-required" in k:
                    try: ch=json.loads(base64.b64decode(v+"==="))
                    except Exception: pass
        acc=(ch or {}).get("accepts") or []
        rec["accepts"]=[{"scheme":a.get("scheme"),"network":a.get("network"),"payTo":a.get("payTo") or a.get("pay_to"),"asset":a.get("asset"),"amount":a.get("amount") or a.get("maxAmountRequired")} for a in acc if isinstance(a,dict)]
        rec["x402Version"]=(ch or {}).get("x402Version")
    return rec
with cf.ThreadPoolExecutor(16) as ex: rows=list(ex.map(probe,sorted(cands)))
json.dump(rows,open("x402_sellers.json","w"),indent=1)
print(collections.Counter(r.get("status") for r in rows))
print("402 sellers",sum(1 for r in rows if r.get("status")==402))
