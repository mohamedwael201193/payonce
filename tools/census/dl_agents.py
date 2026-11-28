import json,sys
from mcp import call
net=sys.argv[1]; out=[]; off=0
while True:
    r=call("list_agents",{"network":net,"limit":500,"offset":off})
    out+=r["agents"]; off+=500
    if off>=r["total"] or not r["agents"]: break
json.dump(out,open(f"agents_{net}.json","w"))
print(net,len(out))
