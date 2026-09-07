# P5 Minimal LAN Access

This is the first minimal P5 deployment step. It exposes the existing web UI
and API to devices on the same local network. Mobile, Cloudflare Tunnel, HTTPS,
SSO, and production reverse-proxy setup are intentionally out of scope.

## Current LAN address

```text
http://10.57.52.253:3000/index.html
```

The address is the current Wi-Fi IPv4 address of the development PC. It can
change when the PC reconnects to Wi-Fi. Re-check it with:

```powershell
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.IPAddress -notmatch '^(127\\.|169\\.254\\.)' }
```

## Services

```text
Web UI:   http://10.57.52.253:3000/index.html
API:      http://10.57.52.253:3001
Collector: http://10.57.52.253:8888/health
```

Only ports 3000 and 3001 are opened to the local subnet. Collector port 8888
is intentionally not opened for the minimal UI test.

## Start

Run PowerShell as Administrator when firewall rules need to be created:

```powershell
powershell -ExecutionPolicy Bypass -File .\\run-local.ps1
```

The frontend Vite server listens on `0.0.0.0:3000`. The API already listens on
all local interfaces. The firewall rules are:

```text
AutoDocu LAN 3000
AutoDocu LAN 3001
AutoDocu LAN 3000 Public
AutoDocu LAN 3001 Public
```

The current Windows Wi-Fi profile is `Public`, so the Public rules are needed
for this test. They allow only `LocalSubnet`; they do not intentionally expose
the ports to arbitrary Internet addresses.

## Test from another device

1. Connect the device to the same Wi-Fi network.
2. Open `http://10.57.52.253:3000/index.html`.
3. Verify the landing page loads.
4. Open the workspace and send a small document question.
5. Confirm the answer and source panel load.

If it does not load, first check that the client is on the same subnet and that
Windows network isolation is not enabled on the Wi-Fi access point.

## Minimal embed note

The existing embed code generator used `localhost` during Vite development.
It now derives the LAN hostname from `window.location.hostname`, so a snippet
generated while opening the UI through the LAN address points at:

```text
http://10.57.52.253:3000/embed/anythingllm-chat-widget.min.js
http://10.57.52.253:3001/api/embed
```

Origin allowlisting and external embed exposure are not enabled by this minimal
step. Before using the widget outside a controlled local test, set
`EMBED_REQUIRE_ALLOWLIST="true"`, register the exact embedding origin, and add
authentication/rate limiting or an internal proxy.

## Stop / rollback

Stop the development services using the existing process manager or terminate
the service processes. Remove the LAN firewall rules when the test is over:

```powershell
Remove-NetFirewallRule -DisplayName 'AutoDocu LAN 3000',
  'AutoDocu LAN 3001',
  'AutoDocu LAN 3000 Public',
  'AutoDocu LAN 3001 Public'
```

This LAN exposure is for development validation only. It is not a production
deployment and does not provide TLS, identity, audit logging, or hardened
Internet-facing access control.
