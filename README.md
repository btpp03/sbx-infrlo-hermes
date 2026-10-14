# sbx-infrlo-hermes

Payload for an **Infrlo** app instance: runs [eooce/sbx-native](https://github.com/eooce/sbx-native)
(sing-box + cloudflared, **no child processes** for those two) with **Nezha v0 agent**
support, packaged as a plain Node.js app that a PaaS can build and run.

Based on the `nodejs/` directory of `btpp03/sbx-native-v0`.

## How it runs on the platform

| Infrlo field | value |
| --- | --- |
| Source | this repo (public), branch `main` |
| Build command | `npm install` |
| Run command | `node index.js` |

No secrets live in the repo — everything is passed as environment variables.

## Environment variables

```ini
UUID=<uuid>                        # node UUID
NAME=<node name>                   # node label shown in clients
SUB_PATH=<random>                  # subscription path (default: sub)
NEZHA_SERVER=nezhak2.btpp.ggff.net # Nezha panel host
NEZHA_PORT=443                     # set => Nezha v0 mode (agent binary child process)
NEZHA_KEY=<agent secret>           # v0 agent key (leave empty => no Nezha)
ARGO_DOMAIN=                       # empty => temporary trycloudflare tunnel
ARGO_AUTH=                         # empty => temporary tunnel; token/json => fixed tunnel
PORT=<http port>                   # subscription HTTP port (platform usually injects)
```

Mode rules (from upstream): `NEZHA_PORT` set → **v0** (downloaded `agent` binary,
auto adds `--tls` when the port is 443/8443/2096/2087/2083/2053); only
`NEZHA_SERVER`+`NEZHA_KEY` set → **v1** (`v1.so` FFI, config.yaml).

## Output

- subscription: `http://<domain>:<PORT>/<SUB_PATH>` → base64 subscription
- plaintext nodes: `FILE_PATH/list.txt` (default `.npm/`)
- runtime artifacts in `FILE_PATH`: `config.json`, `boot.log`, `sub.txt`, `keypair.properties`,
  `agent-v0`
