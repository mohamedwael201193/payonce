import json, sys, urllib.request, time
URL="https://agent-registry-mcp.concordium.com/mcp"
def call(name, args, retries=4):
    body=json.dumps({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":name,"arguments":args}}).encode()
    for i in range(retries):
        try:
            req=urllib.request.Request(URL,body,{"content-type":"application/json","accept":"application/json, text/event-stream"})
            t=urllib.request.urlopen(req,timeout=60).read().decode()
            if t.startswith("event:") or t.startswith("data:"):
                t=[l[5:] for l in t.splitlines() if l.startswith("data:")][-1]
            d=json.loads(t)
            if "error" in d: raise Exception(d["error"])
            r=d["result"]
            if r.get("structuredContent") is not None: return r["structuredContent"]
            txt=r["content"][0]["text"]
            try: return json.loads(txt)
            except: return {"_text":txt,"_isError":r.get("isError")}
        except Exception as e:
            if i==retries-1: raise
            time.sleep(2*(i+1))
if __name__=="__main__":
    print(json.dumps(call(sys.argv[1], json.loads(sys.argv[2])),indent=1)[:6000])
