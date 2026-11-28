"""Build census_public.json (page-ready) from the CSV/JSON outputs. No new network calls."""
import json,csv,collections,time,os
T=lambda x:x=='True'
out={"schema":"payonce-vop-census/v1","generated_at_utc":time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
     "method":"tools/census/METHOD.md","vop_rule":"badge valid (official check) AND agentWallet set AND payee account holds a business identity (Global FinReg)","networks":{}}
for n in ["mainnet","testnet"]:
    r=list(csv.DictReader(open(f"census_{n}.csv"))); N=len(r)
    act=[x for x in r if x["status"]=="Active"]; v=[x for x in r if T(x["badge_valid_official"])]
    owners={x["owner_account"]:x["owner_idp"] for x in r}
    out["networks"][n]={
      "agents_total":N,"active":len(act),"badge_valid_official":len(v),
      "agents_that_pass_vop_today":sum(T(x["vop_pass_today"]) for x in r),
      "pct_pass_vop_today":round(100*sum(T(x["vop_pass_today"]) for x in r)/N,2),
      "valid_badge_but_payee_has_only_personal_identity_or_none":sum(1 for x in v if not T(x["payee_business_id"])),
      "payee_equals_owner_default":sum(1 for x in r if x["agent_wallet"] and T(x["payee_is_owner"])),
      "payee_not_set":sum(1 for x in r if not x["agent_wallet"]),
      "owner_ne_payee":sum(1 for x in r if x["agent_wallet"] and not T(x["payee_is_owner"])),
      "owner_business_but_payee_personal":sum(1 for x in r if T(x["owner_business_id"]) and not T(x["payee_business_id"]) and x["agent_wallet"]),
      "distinct_owners":len(owners),"distinct_owners_with_business_id":sum(1 for i in owners.values() if "Global FinReg" in i),
      "cards_mentioning_x402_text":sum(T(x["card_mentions_x402"]) for x in r),
      "owner_identity_provider_breakdown":dict(collections.Counter(owners.values())),
    }
if os.path.exists("vop_testnet_results.json"):
    vt=json.load(open("vop_testnet_results.json"))
    out["check_payee_live_on_testnet_payees"]={"accounts_checked":len(vt),"verdicts":dict(collections.Counter(x["verdict"] for x in vt)),
        "note":"invoice name used = the agent card name; MATCH needs a payee-book binding with a proven legal name, which no account outside PayOnce has"}
if os.path.exists("x402_vop_results.json"):
    xv=json.load(open("x402_vop_results.json"))
    out["x402_sellers"]={"concordium_endpoints_checked":len(xv),"rows":[{k:x[k] for k in ("endpoint","network","payTo","amount","asset","registry_agents_for_payTo","owner_ne_payTo","payTo_idp","payTo_business_id","check_payee_verdict")} for x in xv],
        "payTo_not_in_registry":sum(1 for x in xv if not x["payTo_is_registry_owner_or_wallet"]),
        "payTo_with_business_identity":sum(1 for x in xv if x["payTo_business_id"])}
    xs=json.load(open("x402_sellers.json"))
    out["x402_sellers"]["endpoints_probed"]=len(xs); out["x402_sellers"]["answering_402"]=sum(1 for x in xs if x.get("status")==402)
    out["x402_sellers"]["non_concordium_402_networks"]=dict(collections.Counter((a.get("network") or "?").split(":")[0] for x in xs for a in x.get("accepts") or [] if not (a.get("network") or "").startswith("ccd")))
json.dump(out,open("census_public.json","w"),indent=1)
print(json.dumps(out,indent=1)[:3500])
