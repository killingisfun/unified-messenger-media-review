# MAX sidecar

`app.py` is the replaceable, private transport boundary for a personal MAX
account.  It owns one PyMax web session under `runtime/max`, binds to
`127.0.0.1:8091`, and currently exposes only QR authentication state.

The PHP application reaches it through `max_auth.php`; browsers reach that
file only via the local bridge's fixed route and session token.  The sidecar
does not read or write the messenger's `data.sqlite`, does not sync chats, and
does not expose any send operation.

Upgrade PyMax by changing the exact version in `requirements.txt`, exercising
the read-only health and QR flow, and then deploying the sidecar as a narrow
release.  Its session directory is data, not release code.
