"""Resolve the identity provider(s) behind each account's credentials by reading the
public CCDExplorer account page (box cannot reach gRPC :20000). Cached in idp_cache.json."""
import json, re, sys, time, html, urllib.request, os
CACHE="idp_cache.json"
cache=json.load(open(CACHE)) if os.path.exists(CACHE) else {}
def idp(net, addr):
    k=f"{net}:{addr}"
    if k in cache and cache[k].get("ok"): return cache[k]
    url=f"https://ccdexplorer.io/{net}/account/{addr}"
    for i in range(3):
        try:
            req=urllib.request.Request(url,headers={"user-agent":"payonce-census/1.0 (research; contact via github mohamedwael201193)"})
            t=urllib.request.urlopen(req,timeout=40).read().decode("utf-8","replace"); break
        except Exception as e:
            t=None; time.sleep(3*(i+1))
    if t is None:
        cache[k]={"ok":False}; return cache[k]
    s=re.sub(r'<script.*?</script>|<style.*?</style>','',t,flags=re.S)
    s=html.unescape(re.sub(r'<[^>]+>',' ',s)); s=re.sub(r'\s+',' ',s)
    provs=re.findall(r'ID Provider (.+?) (?:Credential ID|Created At)',s)
    m=re.search(r'This account needs (\d+) identit',s)
    cache[k]={"ok":True,"providers":sorted(set(p.strip() for p in provs)),"n_cred_blocks":len(provs),"threshold":int(m.group(1)) if m else None,
              "found_page": "Credentials" in s}
    return cache[k]
if __name__=="__main__":
    accts=[]
    for net in ["mainnet","testnet"]:
        a=json.load(open(f"agents_{net}.json"))
        s=set()
        for x in a:
            s.add(x["owner_account"])
            if x.get("agent_wallet"): s.add(x["agent_wallet"])
        accts+= [(net,y) for y in sorted(s)]
    print("accounts",len(accts),flush=True)
    for i,(net,ad) in enumerate(accts):
        r=idp(net,ad)
        if i%10==0:
            json.dump(cache,open(CACHE,"w")); print(i,net,ad[:10],r,flush=True)
        time.sleep(1.0)
    json.dump(cache,open(CACHE,"w")); print("done")
