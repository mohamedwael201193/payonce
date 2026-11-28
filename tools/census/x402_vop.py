"""check_payee on every Concordium payTo found in live x402 challenges (testnet: full check; mainnet: identity-only mode), cross-referenced with the registry."""
import json,time,urllib.request,urllib.parse,collections,csv
import idp_scrape
API="https://payonce-api-n98a.onrender.com/api/vop/check"; SELLER="3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr"
NET={"ccd:4221332d34e1694168c2a0c0b3fd0f27":"testnet","ccd:9dd9ca4d19e9393877d2c44b70f89acb":"mainnet"}
ag={n:json.load(open(f"agents_{n}.json")) for n in NET.values()}
cards={n:json.load(open(f"cards_{n}.json")) for n in NET.values()}
rows=[]; seen=set()
for s in json.load(open("x402_sellers.json")):
    for a in s.get("accepts") or []:
        net=NET.get((a.get("network") or "")[:36]) or NET.get(a.get("network") or "")
        if not net or not a.get("payTo"): continue
        k=(s["url"],a["payTo"])
        if k in seen: continue
        seen.add(k); p=a["payTo"]
        reg=[x for x in ag[net] if p in (x.get("owner_account"),x.get("agent_wallet"))]
        owner_neq=[x for x in reg if x.get("owner_account")!=p]
        idp=idp_scrape.idp(net,p); provs=idp.get("providers",[])
        name=""
        for x in reg:
            c=cards[net].get(x.get("agent_uri") or "",{})
            if c.get("name"): name=c["name"]; break
        name=name or s["url"].split("/")[2]
        v={}
        q=urllib.parse.urlencode({"network":net,"seller":SELLER,"payee":p,"name":name})
        for t in range(4):
            try: v=json.loads(urllib.request.urlopen(API+"?"+q,timeout=60).read()); break
            except Exception as e: time.sleep(5)
        rows.append({"endpoint":s["url"],"network":net,"payTo":p,"amount":a.get("amount"),"asset":a.get("asset"),
            "registry_agents_for_payTo":",".join(str(x["token_id"]) for x in reg),"payTo_is_registry_owner_or_wallet":bool(reg),
            "owner_ne_payTo":bool(owner_neq),"payTo_idp":"|".join(provs),"payTo_business_id":any("Global FinReg" in x for x in provs),
            "invoice_name_used":name,"check_payee_verdict":v.get("verdict") or "ERROR",
            "check_payee_reason":((v.get("reasons") or [""])[0][:200] if v else ""),"evidence_hash":v.get("evidence_hash")})
        time.sleep(2.2)
json.dump(rows,open("x402_vop_results.json","w"),indent=1)
with open("x402_vop_results.csv","w",newline="") as f:
    w=csv.DictWriter(f,fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
print(len(rows),collections.Counter(r["check_payee_verdict"] for r in rows),"business",sum(r["payTo_business_id"] for r in rows),"in registry",sum(r["payTo_is_registry_owner_or_wallet"] for r in rows))
