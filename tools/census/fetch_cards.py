"""Fetch every registered agent's card once, hash it, and record what it exposes.
Output: cards_{net}.json keyed by agent_uri."""
import json, sys, hashlib, urllib.request, concurrent.futures as cf, threading, collections, time, ssl
net=sys.argv[1]
agents=json.load(open(f"agents_{net}.json"))
uris=sorted(set(a["agent_uri"] for a in agents if a.get("agent_uri")))
host_sem=collections.defaultdict(lambda: threading.Semaphore(4))
host_fail=collections.Counter()  # circuit breaker: after 6 network failures (timeouts/conn errors) a host is marked unreachable
ctx=ssl.create_default_context()
def fetch(u):
    rec={"uri":u}
    if not u.startswith(("http://","https://")):
        rec.update(status=None,error="non-http uri"); return rec
    h=u.split("/")[2]
    with host_sem[h]:
        if host_fail[h]>=6:
            rec.update(status=None,error="host unreachable (circuit breaker after 6 network failures)"); return rec
        try:
            req=urllib.request.Request(u,headers={"user-agent":"payonce-census/1.0","accept":"application/json"})
            r=urllib.request.urlopen(req,timeout=20,context=ctx)
            body=r.read(2_000_000); rec["status"]=r.status
        except urllib.error.HTTPError as e:
            rec.update(status=e.code); return rec
        except Exception as e:
            host_fail[h]+=1
            rec.update(status=None,error=type(e).__name__+": "+str(e)[:120]); return rec
    rec["sha256"]=hashlib.sha256(body).hexdigest()
    try: card=json.loads(body)
    except Exception: rec["json"]=False; return rec
    rec["json"]=True
    s=json.dumps(card).lower()
    try:
        caps=card.get("capabilities") if isinstance(card,dict) else None
        ext=caps.get("extensions") if isinstance(caps,dict) else None
        exts=[e.get("uri","") for e in (ext or []) if isinstance(e,dict)] if isinstance(ext,list) else []
    except Exception: exts=[]
    rec["badge_ext"]=any("concordium-badge" in x for x in exts)
    rec["legacy_concordium_block"]=isinstance(card,dict) and isinstance(card.get("concordium"),dict)
    rec["ext_uris"]=exts[:10]
    # payment exposure heuristics (documented in METHOD.md)
    rec["mentions_x402"]="x402" in s
    rec["mentions_payment"]=any(k in s for k in ["payment","\"pay\"","invoice","checkout","price","pricing","ap2"])
    rec["name"]=(card.get("name") if isinstance(card,dict) else None)
    rec["url"]=(card.get("url") if isinstance(card,dict) else None)
    rec["provider"]=(card.get("provider") if isinstance(card,dict) else None)
    return rec
out={}
t=time.time()
with cf.ThreadPoolExecutor(32) as ex:
    for i,r in enumerate(ex.map(fetch,uris)):
        out[r["uri"]]=r
        if i%500==0: print(net,i,len(uris),round(time.time()-t),flush=True)
json.dump(out,open(f"cards_{net}.json","w"))
print("done",net,len(out),collections.Counter(r.get("status") for r in out.values()).most_common(8))
