"""Command line for headless Pis (no monitor, no browser needed).

    docker exec autodarter-board autodarter            # status incl. pairing code
    docker exec autodarter-board autodarter code       # only the pairing code
    docker exec autodarter-board autodarter server https://darts.example.com
    docker exec autodarter-board autodarter restart    # restart the board client

It talks to the running board client on http://127.0.0.1:<LOCAL_PORT>.
"""
from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from pathlib import Path

from .config import LOCAL_PORT

BASE = f"http://127.0.0.1:{LOCAL_PORT}"
USAGE = """Autodarter Board – Befehle:
  autodarter              Status mit Kopplungscode
  autodarter code         nur den Kopplungscode ausgeben
  autodarter server URL   Server-Adresse setzen, z. B. https://darts.example.com
  autodarter restart      Board-Client neu starten
  autodarter compose      docker-compose.yml für den Pi ausgeben (Images von Docker Hub)
"""


def request(path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=5) as res:
        return json.loads(res.read() or b"{}")


def status() -> dict:
    try:
        return request("/api/status")
    except (urllib.error.URLError, OSError) as err:
        print(f"Board-Client nicht erreichbar auf {BASE} ({err}). Läuft der Container?", file=sys.stderr)
        sys.exit(2)


def print_status(s: dict) -> None:
    st = s.get("status", {})
    print(f"Board-ID:   {s.get('boardId')}")
    print(f"Version:    {st.get('version')}")
    print(f"Server:     {s.get('server') or '(nicht gesetzt – autodarter server https://…)'}")
    print(f"Verbindung: {'verbunden' if s.get('connected') else 'NICHT verbunden'}" + (f" – {s['serverError']}" if s.get("serverError") else ""))
    if s.get("claimed"):
        print(f"Konto:      verbunden (Board „{s.get('name') or ''}“)")
    code = s.get("pairingCode")
    if code:
        label = "Code für weitere Spieler" if s.get("claimed") else "KOPPLUNGSCODE"
        print()
        print(f"  {label}:  {code}")
        print("  In der App: Boards → Board hinzufügen")
        print()
    elif not s.get("connected"):
        print("Kopplungscode: erscheint, sobald der Server erreichbar ist.")
    print(f"Erkennung:  {st.get('state')} · {st.get('darts')} Darts · {st.get('fps')} FPS" + (f" · {st['message']}" if st.get("message") else ""))
    for c in st.get("cameras", []):
        print(
            f"Kamera {c['index'] + 1}:   {c['name']} ({c['device']}) {c['width']}x{c['height']} · {c['fps']} FPS · "
            + ("ok" if c["ok"] else "KEIN BILD")
            + (" · kalibriert" if c["calibrated"] else " · nicht kalibriert")
        )


def main(argv: list[str]) -> int:
    cmd = argv[0] if argv else "status"
    if cmd in ("-h", "--help", "help"):
        print(USAGE)
        return 0
    if cmd == "compose":
        # works without a running board client:  docker run --rm <image> autodarter compose > docker-compose.yml
        sys.stdout.write(Path(__file__).with_name("pi-compose.yml").read_text(encoding="utf-8"))
        return 0
    if cmd == "status":
        print_status(status())
        return 0
    if cmd == "code":
        s = status()
        if not s.get("pairingCode"):
            print("Noch kein Kopplungscode – der Board-Client erreicht den Server nicht:", s.get("serverError") or "?", file=sys.stderr)
            return 1
        print(s["pairingCode"])
        return 0
    if cmd == "server" and len(argv) == 2:
        request("/api/server", {"url": argv[1]})
        print(f"Server-Adresse gesetzt: {argv[1]} – verbinde neu …")
        return 0
    if cmd == "restart":
        request("/api/command", {"action": "restart"})
        print("Board-Client startet neu.")
        return 0
    print(USAGE, file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
