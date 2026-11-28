# grpcweb-proxy — testnet-only gRPC-web relay (port 443)

Some networks cannot reach `grpc.testnet.concordium.com:20000`. This 150-line, zero-dependency
Node service relays gRPC-web (HTTP/1.1 and h2 from the client side) to the testnet node over h2.

- Upstream hard-coded to Concordium **testnet** (override only via `UPSTREAM`).
- Only `POST /concordium.v2.Queries/<Method>` (includes `SendBlockItem`); everything else 404.
- Per-IP token bucket (25 req/s, burst 100), 512 KiB body cap, 60 s stream cap, 150 in-flight cap.
- CORS for `chrome-extension://`, localhost and payonce/onrender origins. No secrets, no state.
- `GET /healthz` for liveness.

Run: `node tools/grpcweb-proxy/server.mjs` (PORT, default 8080).
Use: `new ConcordiumGRPCWebClient('https://<host>', 443)`; Wallet extension: Settings → Network → Custom network.
