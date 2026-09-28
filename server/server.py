"""SelfTrack Mail local tracking server (Python stdlib only).

- GET  /o/<id>.gif      : tracking pixel (public, exposed through a tunnel)
- GET  /health          : health check
- POST /api/messages    : register a sent message          (token required)
- GET  /api/messages    : recent messages with open stats  (token required)
- POST /api/self-view   : sender is viewing these ids, ignore their hits (token required)
- POST /api/messages/delete : {"ids": [...]} or {"all": true}; deletes messages and their opens (token required)
- GET  /api/opens       : settled opens after a cursor, for notifications (token required)

/api/* only accepts direct local requests; anything coming through a tunnel is rejected.
"""

import json
import os
import re
import secrets
import socket
import sqlite3
import ssl
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST = os.environ.get("MT_HOST", "127.0.0.1")
PORT = int(os.environ.get("MT_PORT", "8787"))
# Set to expose the pixel directly on this PC's public IP (e.g. 80) instead of using a tunnel.
PUBLIC_PORT = int(os.environ.get("MT_PUBLIC_PORT", "0"))
# Optional HTTPS listener for the pixel (e.g. 443). Webmail that loads images directly in the browser
# (Naver, Outlook web, ...) upgrades http:// images on https pages to https://, so this is needed there.
HTTPS_PORT = int(os.environ.get("MT_HTTPS_PORT", "0"))
CERT_FILE = os.environ.get("MT_CERT_FILE", "")
KEY_FILE = os.environ.get("MT_KEY_FILE", "")
# Where the token and database live; keep this outside the repo for real use.
DATA_DIR = os.environ.get("MT_DATA_DIR") or os.path.dirname(os.path.abspath(__file__))
os.makedirs(DATA_DIR, exist_ok=True)
DB_PATH = os.path.join(DATA_DIR, "mailtrack.db")
CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
# ACME HTTP-01 webroot: an ACME client (e.g. lego --http.webroot) writes challenge files here and the
# public HTTP listener serves them, so certificates can be issued/renewed while the server keeps running.
ACME_DIR = os.path.join(DATA_DIR, "acme")

SEND_GRACE = 10      # ignore hits within N seconds after sending (compose preview, Gmail's own render)
SELF_VIEW_WINDOW = 30  # a self-view deletes hits from the last N seconds and suppresses the next N seconds
SETTLE = 20          # opens younger than N seconds are not reported yet (so self-view can cancel them)

PIXEL = (
    b"GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00!\xf9\x04\x01\x00\x00\x00\x00"
    b",\x00\x00\x00\x00\x01\x00\x01\x00\x00\x02\x02D\x01\x00;"
)
PIXEL_RE = re.compile(r"^/o/(mt[A-Za-z0-9]{20})\.gif$")
ACME_RE = re.compile(r"^/\.well-known/acme-challenge/([A-Za-z0-9_-]{10,128})$")
ID_RE = re.compile(r"^mt[A-Za-z0-9]{20}$")
TUNNEL_HEADERS = ("x-forwarded-for", "cf-connecting-ip", "x-real-ip", "forwarded")

# Abuse limits for the public pixel endpoint.
MAX_CONNECTIONS = 64     # concurrent connections per listener; extra ones are dropped
IP_LIMIT_PER_MIN = 120   # pixel requests per source IP per minute
DEDUPE_SECONDS = 10      # repeated hits for the same (message, IP) within this window are not stored
MAX_UA_LEN = 300


def load_token():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, encoding="utf-8") as f:
            return json.load(f)["token"]
    token = secrets.token_urlsafe(24)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump({"token": token}, f)
    return token


TOKEN = load_token()
db_lock = threading.Lock()
db = sqlite3.connect(DB_PATH, check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript(
    """
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        subject TEXT NOT NULL DEFAULT '',
        recipients TEXT NOT NULL DEFAULT '[]',
        sent_at REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS opens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        msg_id TEXT NOT NULL,
        ts REAL NOT NULL,
        ua TEXT,
        ip TEXT
    );
    CREATE INDEX IF NOT EXISTS opens_msg ON opens(msg_id);
    CREATE TABLE IF NOT EXISTS suppress (
        msg_id TEXT PRIMARY KEY,
        until REAL NOT NULL
    );
    """
)


def add_column(table, column, decl):
    if column not in [r["name"] for r in db.execute(f"PRAGMA table_info({table})")]:
        db.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")


# Hits are never deleted; ignored ones keep the reason ('grace', 'self') for debugging.
add_column("opens", "ignored", "TEXT")
add_column("messages", "sender", "TEXT NOT NULL DEFAULT ''")
db.commit()


def is_gmail_proxy(ua):
    # Gmail web always fetches images through this proxy, so the sender viewing their own mail in
    # Gmail can only ever produce proxy hits. Direct browser hits are never a Gmail self-view.
    return "GoogleImageProxy" in (ua or "")


def record_hit(msg_id, ua, ip):
    now = time.time()
    with db_lock:
        msg = db.execute("SELECT sent_at FROM messages WHERE id = ?", (msg_id,)).fetchone()
        if msg is None:
            return "unknown id"
        ignored = None
        if now < msg["sent_at"] + SEND_GRACE:
            ignored = "grace"
        elif is_gmail_proxy(ua):
            sup = db.execute("SELECT until FROM suppress WHERE msg_id = ?", (msg_id,)).fetchone()
            if sup is not None and sup["until"] > now:
                ignored = "self"
        db.execute(
            "INSERT INTO opens (msg_id, ts, ua, ip, ignored) VALUES (?, ?, ?, ?, ?)",
            (msg_id, now, ua, ip, ignored),
        )
        db.commit()
        return f"ignored ({ignored})" if ignored else "recorded"


def self_view(ids, viewer):
    now = time.time()
    with db_lock:
        for msg_id in ids:
            msg = db.execute("SELECT sender FROM messages WHERE id = ?", (msg_id,)).fetchone()
            # Only the sender's own account counts; the recipient may use the same browser.
            if msg is None or (viewer and msg["sender"] and viewer != msg["sender"]):
                continue
            db.execute(
                "UPDATE opens SET ignored = 'self' "
                "WHERE msg_id = ? AND ts >= ? AND ignored IS NULL AND ua LIKE '%GoogleImageProxy%'",
                (msg_id, now - SELF_VIEW_WINDOW),
            )
            db.execute(
                "INSERT INTO suppress (msg_id, until) VALUES (?, ?) "
                "ON CONFLICT(msg_id) DO UPDATE SET until = excluded.until",
                (msg_id, now + SELF_VIEW_WINDOW),
            )
        db.commit()


def register(data):
    msg_id = str(data.get("id", ""))
    if not ID_RE.match(msg_id):
        raise ValueError("invalid id")
    recipients = [str(r) for r in data.get("recipients", [])][:100]
    with db_lock:
        db.execute(
            "INSERT OR REPLACE INTO messages (id, subject, recipients, sender, sent_at) VALUES (?, ?, ?, ?, ?)",
            (msg_id, str(data.get("subject", ""))[:500], json.dumps(recipients),
             str(data.get("sender", "")).lower()[:200], time.time()),
        )
        db.commit()


def delete_messages(ids=None):
    """Delete messages and their opens. ids=None deletes everything. Later hits for a deleted id are ignored."""
    with db_lock:
        if ids is None:
            count = db.execute("SELECT COUNT(*) FROM messages").fetchone()[0]
            db.execute("DELETE FROM opens")
            db.execute("DELETE FROM suppress")
            db.execute("DELETE FROM messages")
        else:
            rows = [(i,) for i in ids]
            count = db.executemany("DELETE FROM messages WHERE id = ?", rows).rowcount
            db.executemany("DELETE FROM opens WHERE msg_id = ?", rows)
            db.executemany("DELETE FROM suppress WHERE msg_id = ?", rows)
        db.commit()
    return count


def list_messages(limit):
    settled = time.time() - SETTLE
    with db_lock:
        rows = db.execute(
            """
            SELECT m.id, m.subject, m.recipients, m.sent_at,
                   COUNT(o.id) AS open_count, MIN(o.ts) AS first_open, MAX(o.ts) AS last_open
            FROM messages m
            LEFT JOIN opens o ON o.msg_id = m.id AND o.ts <= ? AND o.ignored IS NULL
            GROUP BY m.id
            ORDER BY m.sent_at DESC
            LIMIT ?
            """,
            (settled, limit),
        ).fetchall()
    return [
        {
            "id": r["id"],
            "subject": r["subject"],
            "recipients": json.loads(r["recipients"]),
            "sent_at": r["sent_at"],
            "open_count": r["open_count"],
            "first_open": r["first_open"],
            "last_open": r["last_open"],
        }
        for r in rows
    ]


def list_opens(after):
    settled = time.time() - SETTLE
    with db_lock:
        rows = db.execute(
            """
            SELECT o.id, o.msg_id, o.ts, m.subject, m.recipients
            FROM opens o JOIN messages m ON m.id = o.msg_id
            WHERE o.id > ? AND o.ts <= ? AND o.ignored IS NULL
            ORDER BY o.id
            LIMIT 50
            """,
            (after, settled),
        ).fetchall()
        # The cursor may only advance past opens that are settled, so stop at the first unsettled one.
        pending = db.execute("SELECT MIN(id) AS id FROM opens WHERE id > ? AND ts > ?", (after, settled)).fetchone()
    opens = [
        {"id": r["id"], "msg_id": r["msg_id"], "ts": r["ts"], "subject": r["subject"],
         "recipients": json.loads(r["recipients"])}
        for r in rows
        if pending["id"] is None or r["id"] < pending["id"]
    ]
    return opens


def latest_open_id():
    with db_lock:
        row = db.execute("SELECT MAX(id) AS id FROM opens").fetchone()
    return row["id"] or 0


class PixelLimiter:
    """In-memory limits so a flood of pixel requests can't grow the DB or hog the server."""

    def __init__(self):
        self.lock = threading.Lock()
        self.ip_hits = {}   # ip -> timestamps within the last minute
        self.last_hit = {}  # (msg_id, ip) -> last stored hit

    def check(self, msg_id, ip):
        now = time.time()
        with self.lock:
            if len(self.ip_hits) > 10000 or len(self.last_hit) > 10000:
                self.ip_hits = {k: v for k, v in self.ip_hits.items() if v and v[-1] > now - 60}
                self.last_hit = {k: t for k, t in self.last_hit.items() if t > now - DEDUPE_SECONDS}
            recent = [t for t in self.ip_hits.get(ip, []) if t > now - 60]
            if len(recent) >= IP_LIMIT_PER_MIN:
                self.ip_hits[ip] = recent
                return "rate limited"
            recent.append(now)
            self.ip_hits[ip] = recent
            if now - self.last_hit.get((msg_id, ip), 0) < DEDUPE_SECONDS:
                return "duplicate"
            self.last_hit[(msg_id, ip)] = now
        return None


limiter = PixelLimiter()


def printable(s, n):
    # User-Agent is attacker-controlled; keep control/ANSI escape characters out of the console.
    return "".join(c if c.isprintable() else "?" for c in s[:n])


class BoundedHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer spawns a thread per connection without limit; cap it."""

    if os.name == "nt":
        # On Windows SO_REUSEADDR lets a second process bind the same port silently (two servers,
        # or port hijacking). Take the port exclusively so a duplicate start fails loudly instead.
        allow_reuse_address = False

        def server_bind(self):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    def __init__(self, addr, handler):
        super().__init__(addr, handler)
        self.slots = threading.BoundedSemaphore(MAX_CONNECTIONS)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()

    def handle_error(self, request, client_address):
        # Scanners and broken clients cause resets, timeouts and failed TLS handshakes; don't spam tracebacks.
        if isinstance(sys.exc_info()[1], OSError):
            return
        super().handle_error(request, client_address)


class TLSServer(BoundedHTTPServer):
    """HTTPS listener that picks up renewed certificate files without a restart."""

    def __init__(self, addr, handler, cert_file, key_file):
        self.cert_file, self.key_file = cert_file, key_file
        self.ctx, self.loaded, self.checked = None, None, 0.0
        self.reload_cert()
        super().__init__(addr, handler)

    def reload_cert(self):
        stamp = (os.path.getmtime(self.cert_file), os.path.getmtime(self.key_file))
        if stamp == self.loaded:
            return
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.minimum_version = ssl.TLSVersion.TLSv1_2
        ctx.load_cert_chain(self.cert_file, self.key_file)
        self.ctx, self.loaded = ctx, stamp
        print(f"[tls] {time.strftime('%H:%M:%S')} certificate loaded: {self.cert_file}")

    def get_request(self):
        sock, addr = self.socket.accept()
        now = time.time()
        if now - self.checked > 60:
            self.checked = now
            try:
                self.reload_cert()
            except (OSError, ssl.SSLError) as e:  # e.g. renewal half-written; keep the old cert, retry later
                print(f"[tls] certificate reload failed, keeping current one: {e}")
        # Handshake runs in the handler thread (see Handler.setup) under the socket timeout,
        # so a slow client can't stall the accept loop.
        return self.ctx.wrap_socket(sock, server_side=True, do_handshake_on_connect=False), addr


class Handler(BaseHTTPRequestHandler):
    server_version = "SelfTrackMail"
    sys_version = ""  # don't advertise the Python version
    timeout = 10  # drop idle/slow connections so they can't pile up threads (slowloris)
    trust_proxy_headers = True  # behind a tunnel the real client IP is in forwarded headers

    def setup(self):
        super().setup()  # applies self.timeout to the socket
        if isinstance(self.request, ssl.SSLSocket):
            self.request.do_handshake()

    def log_message(self, fmt, *args):
        pass  # pixel hits are logged in do_GET with their outcome

    def send_json(self, status, body):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def api_allowed(self):
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return False
        if any(self.headers.get(h) for h in TUNNEL_HEADERS):
            return False
        return secrets.compare_digest(self.headers.get("X-MT-Token", ""), TOKEN)

    def read_json(self):
        length = int(self.headers.get("Content-Length", "0"))
        if not 0 <= length <= 64 * 1024:
            raise ValueError("invalid body size")
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self):
        url = urlparse(self.path)
        m = PIXEL_RE.match(url.path)
        if m:
            ip = self.client_address[0]
            if self.trust_proxy_headers:
                forwarded = self.headers.get("CF-Connecting-IP") or self.headers.get("X-Forwarded-For") or ""
                ip = forwarded.split(",")[0].strip()[:64] or ip
            ua = self.headers.get("User-Agent", "")[:MAX_UA_LEN]
            blocked = limiter.check(m.group(1), ip)
            outcome = blocked or record_hit(m.group(1), ua, ip)
            if blocked != "rate limited":  # don't let a flood spam the console either
                source = "gmail-proxy" if is_gmail_proxy(ua) else printable(ua, 60)
                print(f"[pixel] {time.strftime('%H:%M:%S')} {m.group(1)} {outcome} ip={printable(ip, 64)} from={source}")
            self.send_response(200)
            self.send_header("Content-Type", "image/gif")
            self.send_header("Content-Length", str(len(PIXEL)))
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
            self.send_header("Pragma", "no-cache")
            self.end_headers()
            self.wfile.write(PIXEL)
            return
        if url.path == "/health":
            self.send_json(200, {"ok": True})
            return
        if url.path.startswith("/api/"):
            if not self.api_allowed():
                self.send_json(403, {"error": "forbidden"})
                return
            qs = parse_qs(url.query)
            try:
                if url.path == "/api/messages":
                    limit = max(1, min(int(qs.get("limit", ["200"])[0]), 1000))
                    self.send_json(200, {"messages": list_messages(limit)})
                    return
                if url.path == "/api/opens":
                    after = qs.get("after", [None])[0]
                    if after is None:
                        self.send_json(200, {"opens": [], "latest": latest_open_id()})
                    else:
                        self.send_json(200, {"opens": list_opens(int(after))})
                    return
            except ValueError as e:
                self.send_json(400, {"error": str(e)})
                return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if not url.path.startswith("/api/") or not self.api_allowed():
            self.send_json(403, {"error": "forbidden"})
            return
        try:
            data = self.read_json()
            if url.path == "/api/messages":
                register(data)
            elif url.path == "/api/self-view":
                ids = [i for i in data.get("ids", []) if ID_RE.match(str(i))]
                self_view(ids, str(data.get("viewer", "")).lower())
                print(f"[self-view] {time.strftime('%H:%M:%S')} {ids} viewer={data.get('viewer', '')}")
            elif url.path == "/api/messages/delete":
                if data.get("all") is True:
                    deleted = delete_messages()
                else:
                    deleted = delete_messages([i for i in data.get("ids", []) if ID_RE.match(str(i))])
                print(f"[delete] {time.strftime('%H:%M:%S')} {deleted} message(s)")
                self.send_json(200, {"ok": True, "deleted": deleted})
                return
            else:
                self.send_json(404, {"error": "not found"})
                return
        except (ValueError, json.JSONDecodeError) as e:
            self.send_json(400, {"error": str(e)})
            return
        self.send_json(200, {"ok": True})


class PublicHandler(Handler):
    """Internet-facing listener: serves only the pixel and /health, never the API."""

    trust_proxy_headers = False  # clients connect directly, so forwarded headers would be forged

    def do_GET(self):
        path = urlparse(self.path).path
        acme = ACME_RE.match(path)
        if acme:
            self.send_acme_challenge(acme.group(1))
        elif PIXEL_RE.match(path) or path == "/health":
            super().do_GET()
        else:
            self.send_json(404, {"error": "not found"})

    def send_acme_challenge(self, token):
        # token is restricted by ACME_RE, so it can't escape the challenge directory
        path = os.path.join(ACME_DIR, ".well-known", "acme-challenge", token)
        try:
            with open(path, "rb") as f:
                body = f.read(4096)
        except OSError:
            self.send_json(404, {"error": "not found"})
            return
        print(f"[acme] {time.strftime('%H:%M:%S')} served challenge {token[:12]}... to {self.client_address[0]}")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        self.send_json(404, {"error": "not found"})


def main():
    print(f"SelfTrack Mail API listening on http://{HOST}:{PORT}")
    if PUBLIC_PORT:
        public = BoundedHTTPServer(("0.0.0.0", PUBLIC_PORT), PublicHandler)
        threading.Thread(target=public.serve_forever, daemon=True).start()
        print(f"SelfTrack Mail pixel listening on http://0.0.0.0:{PUBLIC_PORT} (public)")
    if HTTPS_PORT:
        if os.path.exists(CERT_FILE) and os.path.exists(KEY_FILE):
            tls = TLSServer(("0.0.0.0", HTTPS_PORT), PublicHandler, CERT_FILE, KEY_FILE)
            threading.Thread(target=tls.serve_forever, daemon=True).start()
            print(f"SelfTrack Mail pixel listening on https://0.0.0.0:{HTTPS_PORT} (public)")
        else:
            print(f"[tls] certificate not found ({CERT_FILE or 'MT_CERT_FILE unset'}); HTTPS disabled for now")
    print(f"Token (paste into the extension popup): {TOKEN}")
    BoundedHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
