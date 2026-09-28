# SelfTrack Mail

**Self-hosted email open tracking for Gmail.** A Chrome extension plus a tiny Python server you run yourself — no third-party tracking service sees your mail.

[한국어 README](README.ko.md)

- ✓ / ✓✓ read receipts in your Gmail **Sent** list and inside opened messages
- Desktop notifications when a recipient opens your email
- Your own views of your sent mail are filtered out
- Zero dependencies on the server side (Python standard library + SQLite)
- Works with recipients on Gmail, Naver, Outlook and other webmail (with HTTPS)

> The extension UI is currently in Korean.

## How it works

```
 Gmail (Chrome)                               Recipient's mail client
  └─ extension inserts a 1x1 pixel on send ──▶  loads https://<your server>/o/<id>.gif
        │                                                   │
        │ 127.0.0.1:8787  (private API)                     ▼ :443 / :80  (public)
        └────────────────▶  server/server.py  (SQLite)  ◀───┘
```

1. When you hit **Send**, the extension appends an invisible tracking image with a random ID and registers the message (subject, recipients) with your server.
2. When the recipient opens the email, their mail client requests that image and the server records an open.
3. The extension polls the server, shows badges in Gmail and fires notifications.

The server has two faces: a **public** listener that only serves the pixel, and a **private API** bound to `127.0.0.1` that only your extension can use (token required).

## Requirements

- Chrome (or another Chromium browser)
- Python 3.9+
- A way for the internet to reach your server — one of:
  - a PC with a **public IP** (ports 80/443 reachable), or
  - a **tunnel** such as `cloudflared` or `ngrok`

## Quick start

### 1. Run the server

```powershell
python server/server.py
```

On first run a token is generated and printed. Keep the token and database outside the repo by pointing `MT_DATA_DIR` somewhere else:

```powershell
$env:MT_DATA_DIR = "C:\selftrack-data"; python server/server.py
```

### 2. Expose the pixel to the internet

#### Option A — Public IP with HTTPS (recommended for long-term use)

HTTPS matters: webmail that loads images directly in the browser (Naver, Outlook web, …) upgrades `http://` images on `https://` pages and they fail without a certificate. Only Gmail recipients (via Google's image proxy) work over plain HTTP.

Let's Encrypt issues short-lived (~6 day) certificates for IP addresses. The server serves `<MT_DATA_DIR>/acme` as an HTTP-01 webroot, so you can issue and renew with [lego](https://github.com/go-acme/lego) while it keeps running:

```powershell
# Allow inbound 80/443 for Python only (admin PowerShell, once)
New-NetFirewallRule -DisplayName "SelfTrack Mail pixel" -Direction Inbound -Protocol TCP -LocalPort 80,443 -Action Allow -Program "<path to python.exe>"

# Start the server with the public HTTP listener (needed for certificate validation)
$env:MT_DATA_DIR = "C:\selftrack-data"; $env:MT_PUBLIC_PORT = "80"
python server/server.py

# In another terminal: get the certificate
lego run --accept-tos --domains <your IP> --profile shortlived --http --http.webroot C:\selftrack-data\acme --path C:\selftrack-data\lego

# Restart the server with HTTPS enabled
$env:MT_HTTPS_PORT = "443"
$env:MT_CERT_FILE = "C:\selftrack-data\lego\certificates\<your IP>.crt"
$env:MT_KEY_FILE  = "C:\selftrack-data\lego\certificates\<your IP>.key"
python server/server.py
```

Schedule the same `lego run` command twice a day (Windows Task Scheduler / cron). lego only renews when due, and the server picks up renewed certificate files within a minute without restarting.

Use `https://<your IP>` as the public URL in the extension.

#### Option B — Tunnel (no public IP)

```powershell
cloudflared tunnel --url http://localhost:8787
```

Use the printed `https://xxxx.trycloudflare.com` address as the public URL. Quick-tunnel addresses **change on every restart**, and emails sent with an old address stop being tracked — for long-term use you need a fixed address (Cloudflare named tunnel with your own domain, or an ngrok static domain).

### 3. Install the extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension` folder.
3. Open the SelfTrack Mail popup, enter the **public URL** and the **server token**, then save.
4. Reload Gmail.

## Usage

- Emails you send are tracked automatically (toggle in the popup).
- **Sent list:** `✓` = sent, `✓✓ N` = opened N times. Hover for first/last open time.
- **Opened message:** a badge above the body shows the open count and last open.
- **Notifications:** checked every 30 seconds.
- **Delete:** remove a single email (×) or everything from the popup. Deleted emails are no longer tracked.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `MT_DATA_DIR` | `server/` | Folder for `config.json` (token), `mailtrack.db`, ACME webroot |
| `MT_HOST` / `MT_PORT` | `127.0.0.1` / `8787` | Private API listener |
| `MT_PUBLIC_PORT` | off | Public HTTP pixel listener (e.g. `80`) |
| `MT_HTTPS_PORT` | off | Public HTTPS pixel listener (e.g. `443`) |
| `MT_CERT_FILE` / `MT_KEY_FILE` | — | PEM certificate (with chain) and key for HTTPS |

## Deciding what counts as an open

| Rule | Why |
|---|---|
| Hits within 10 s of sending are ignored | Your compose window and Gmail rendering the sent message |
| A *self-view* cancels Google-proxy hits from the last 30 s and suppresses the next 30 s | You reading your own sent mail in Gmail (only applies to the sending account) |
| Opens are reported after 20 s | Gives a self-view time to cancel before a notification fires |
| Same message + IP within 10 s is stored once | Duplicate loads |
| Ignored hits are kept with a reason | So you can see why something wasn't counted |

## Security

- The API only accepts local connections with a valid token (constant-time comparison); requests arriving through a tunnel are rejected.
- Public listeners serve only the pixel, `/health` and ACME challenges — everything else is 404.
- Abuse limits: 64 concurrent connections, 10 s socket timeout, 120 requests/min per IP, 64 KB request bodies, truncated User-Agent, exclusive port binding on Windows.
- Parameterized SQL everywhere; forwarded-IP headers are ignored on public listeners; control characters are stripped from logs.
- The extension builds DOM with `textContent` only (no `innerHTML`).
- **Never commit** `config.json` or `mailtrack.db` (already in `.gitignore`).

## Limitations

- **Repeat opens in the same page** often aren't counted — browsers reuse an already-loaded image. Gmail's image proxy caches as well.
- Recipients who block images are not tracked; Apple Mail Privacy Protection may report opens that didn't happen.
- Opens while your server is offline are lost.
- The pixel URL is visible in the email source, so recipients can see your server address (your IP in public-IP mode).
- The Sent-list badge matches by subject + recipients; the in-message badge matches exactly by pixel ID.
- Gmail's DOM (`.a3s`, `tr.zA`, `.bog`, `.aoO`, …) can change and break the extension.
- The server is a personal tool built on Python's `http.server`, not a multi-tenant production service.

## Privacy & responsible use

This tool records when recipients open your emails, along with their IP address and User-Agent. Check the privacy laws that apply to you and your recipients, and use it responsibly.

## License

[MIT](LICENSE)
