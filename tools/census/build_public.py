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
if os.path.exists("vop_mainnet_results.json"):
    vm=json.load(open("vop_mainnet_results.json"))
    out["check_payee_live_on_mainnet_payees"]={"mode":"identity_only","accounts_checked":len(vm),"agents_covered":sum(x["agents"] for x in vm),
        "verdicts":dict(collections.Counter(x["verdict"] for x in vm)),"identity_kind":dict(collections.Counter(x["identity_kind"] for x in vm)),
        "accounts_with_business_identity":sum(1 for x in vm if x["identity_kind"]=="business"),"payable":sum(1 for x in vm if x["payable"]),
        "answered_from":dict(collections.Counter(x["source"] for x in vm)),
        "note":"mainnet mode is identity-only: never MATCH, never payable. The payee book is testnet-only, so no mainnet account is bound to a legal name by its own signature"}
if os.path.exists("x402_vop_results.json"):
    xv=json.load(open("x402_vop_results.json"))
    out["x402_sellers"]={"concordium_endpoints_checked":len(xv),"rows":[{k:x[k] for k in ("endpoint","network","payTo","amount","asset","registry_agents_for_payTo","owner_ne_payTo","payTo_idp","payTo_business_id","check_payee_verdict")} for x in xv],
        "payTo_not_in_registry":sum(1 for x in xv if not x["payTo_is_registry_owner_or_wallet"]),
        "payTo_with_business_identity":sum(1 for x in xv if x["payTo_business_id"])}
    xs=json.load(open("x402_sellers.json"))
    out["x402_sellers"]["endpoints_probed"]=len(xs); out["x402_sellers"]["answering_402"]=sum(1 for x in xs if x.get("status")==402)
    out["x402_sellers"]["non_concordium_402_networks"]=dict(collections.Counter((a.get("network") or "?").split(":")[0] for x in xs for a in x.get("accepts") or [] if not (a.get("network") or "").startswith("ccd")))
# Payee-change feed: what moved since the previous run (agentWallet = where money goes; "bank details changed" on chain).
def snap(path):
    return {str(a["token_id"]):a for a in json.load(open(path))} if os.path.exists(path) else None
chg={}
for n in ["mainnet","testnet"]:
    old,new=snap(f"prev_agents_{n}.json"),snap(f"agents_{n}.json")
    if old is None: continue
    pay=lambda a:a.get("agent_wallet") or a["owner_account"]
    both=set(old)&set(new)
    moved=[{"token_id":int(t),"from":pay(old[t]),"to":pay(new[t]),"owner_unchanged":old[t]["owner_account"]==new[t]["owner_account"]} for t in sorted(both,key=int) if pay(old[t])!=pay(new[t])]
    chg[n]={"new_agents":len(set(new)-set(old)),"removed_agents":len(set(old)-set(new)),"payee_changed":len(moved),"payee_changed_examples":moved[:25]}
if chg:
    prev=json.load(open("prev_census_public.json")).get("generated_at_utc") if os.path.exists("prev_census_public.json") else None
    out["changes_since_previous_run"]={"previous_generated_at_utc":prev,"networks":chg,"meaning":"payee = agentWallet, or the owner when unset. A changed payee on an existing token is the on-chain form of 'our bank details changed'."}
# Sample verification (census_verification.json: a node re-read of a sample; written by verify-sample.mjs or GET /api/census/verify)
SV="Identity-provider attribution comes from CCDExplorer's public page. It has not been re-read from a node in this run: say 'read from CCDExplorer', not 'verified on chain'. Run tools/census/verify-sample.mjs from a machine with gRPC access."
if os.path.exists("census_verification.json"):
    cv=json.load(open("census_verification.json")); nv=cv["networks"]
    parts=[f"{n}: {nv[n]['agree']} of {nv[n]['agree']+nv[n]['mismatch']} accounts agree (all {nv[n]['business_accounts_in_census']} business-identity accounts included)" for n in ("mainnet","testnet")]
    out["verification"]={k:cv[k] for k in ("schema","verified_at_utc","run_by","census_generated_at_utc","all_agree","scope")}
    out["verification"]["networks"]={n:{k:nv[n][k] for k in ("accounts_in_census","business_accounts_in_census","business_accounts_checked","sample_size","agree","mismatch","node_errors","census_unattributed","agreement_rate")} for n in nv}
    out["verification"]["file"]="tools/census/census_verification.json"
    SV=("Identity attribution verified on chain for a sample: "+"; ".join(parts)+f". Each account's credentials were re-read from a Concordium node (getAccountInfo) on {cv['verified_at_utc'][:10]} by {cv['run_by']}. "
        "This verifies the identity-provider attribution for those accounts only, not badges, cards or every account in the census." if cv["all_agree"] else
        "Sample verification found disagreement or node errors: "+"; ".join(f"{n} {nv[n]['mismatch']} mismatches, {nv[n]['node_errors']} node errors" for n in nv)+". Do not say 'verified on chain'; see tools/census/census_verification.json.")
# Precise wording (the page must use these, not paraphrase): numbers are computed from this same file.
m,t=out["networks"]["mainnet"],out["networks"]["testnet"]
out["wording"]={
 "headline":f"At most {m['agents_that_pass_vop_today']} of {m['agents_total']:,} agents in the Concordium mainnet registry ({m['pct_pass_vop_today']}%) meet the preconditions of a Verification-of-Payee check today; on testnet, {t['agents_that_pass_vop_today']} of {t['agents_total']:,}.",
 "upper_bound":"These are upper bounds. 'Pass' only means the technical preconditions hold (valid Verified-by-Concordium badge, an agentWallet is set, and the account receiving payment holds a business identity from Global FinReg). It does not prove the legal name matches an invoice: that needs a payee-signed name binding (PayOnce v3, testnet) or a zero-knowledge name proof.",
 "definitions":{
   "agents_total":"Tokens returned by the registry's list_agents for the network, at generated_at_utc.",
   "badge_valid_official":"The registry's own check-badge endpoint (/v1/check-badge/{token}) returned badge_valid=true.",
   "payee":"The account that receives money for the agent: its agentWallet, or its owner when none is set (registry semantics).",
   "business_identity":"The payee account holds a credential issued by a business identity provider: Global FinReg (mainnet idp 3, testnet idp 4). Notabene, Digital Trust Solutions and Concordium's testnet IP issue personal identities.",
   "agents_that_pass_vop_today":"badge_valid_official AND agentWallet set AND payee holds a business identity.",
   "payee_equals_owner_default":"agentWallet is set and equals the owner. The registry defaults agentWallet to the owner on registration, so this is mostly the default, not a deliberate choice of a payee.",
   "payee_not_set":"No agentWallet on the token (payee falls back to the owner)."},
 "sources":"Registry lists and badge checks: Concordium's hosted agent-registry MCP/REST. Account identity providers: the public CCDExplorer account page (the census host cannot reach a node's gRPC port); the live check_payee reads the node directly. Cards: the agent_uri of each token, fetched once per run.",
 "sample_verification":SV,
 "does_not_claim":["that any agent is fraudulent","that a business identity belongs to the company named on an invoice","that accounts outside the registry or x402 sellers we did not probe behave the same","a count of all Concordium agents: only registered, listed tokens"]}
json.dump(out,open("census_public.json","w"),indent=1)
print(json.dumps(out,indent=1)[:3500])
