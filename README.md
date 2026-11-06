# Autodarter 🎯

Selbst gehostete, quelloffene Alternative zu Autodarts: automatische Dart-Erkennung mit **3 USB-Kameras an einem Raspberry Pi 5** und ein **eigener Server**. Keine Cloud, keine langsamen fremden Server. Alles läuft in deinem Netz.

```
 ┌──────────── Raspberry Pi 5 ────────────┐          ┌──────────── Server (docker compose) ────────────┐
 │ 3× USB-Kamera ─► Board-Client (Python)  │  WebSocket │  Fastify-API + WebSockets (Node/TypeScript)      │
 │   • Kameraerkennung (V4L2)              │ ─────────► │  • Konten, Boards (Kopplung), Spiele, Statistik  │
 │   • Dart-/Takeout-Erkennung (OpenCV)    │ ◄───────── │  • Spiel-Engine X01 / Cricket (event-sourced)    │
 │   • Statusseite :3180 (Kopplungscode)   │            │  • liefert die Web-App aus          PostgreSQL   │
 └─────────────────────────────────────────┘            └──────────────────────────▲───────────────────────┘
                                                                                  │ HTTP + WebSocket
                                                         Browser / Handy: React-Native-App (Expo, Web + iOS/Android)
```

| Teil | Ordner | Technik |
|---|---|---|
| Spiel-Engine, Board-Geometrie, Protokoll | [`shared/`](shared) | TypeScript (von Server **und** App genutzt) |
| Server (Betrieb) | [`server/`](server) | Node 24, Fastify, WebSockets, PostgreSQL |
| App / Website | [`app/`](app) | React Native mit Expo Router (läuft als Website, iOS, Android) |
| Board-Client für den Pi | [`board/`](board) | Python 3.12, OpenCV, aiohttp |

## Funktionen

- **Konto & Login**: Registrieren, Anmelden (JWT), Profil, Passwort ändern
- **Board zum Konto hinzufügen**: Der Pi zeigt einen 6-stelligen Kopplungscode (Statusseite `:3180` und Log). Diesen gibst du in der App unter *Boards → Board hinzufügen* ein. Ein Board lässt sich umbenennen und wieder entfernen.
- **Kameras live ansehen**: Livebild aller Kameras in der App, mit eingeblendetem Board-Raster der Kalibrierung und der erkannten Dartspitze
- **Kalibrieren** wie bei Autodarts: Pro Kamera ziehst du 4 Punkte auf die Außenkante des Doppelrings (20|1, 6|10, 3|19, 11|14), dazu einen 5. Punkt auf das Bull.
  - Das Board-Raster wird dabei live projiziert.
  - Zum Feinjustieren gibt es eine Lupe, Pfeiltasten und Pfeil-Buttons.
- **Automatische Erkennung**:
  - Würfe aus allen Kameras werden zusammengeführt.
  - Takeout (Hand am Board) wird erkannt und schaltet zum nächsten Spieler weiter.
  - Bewegt sich eine Hand am Board, ohne Darts zu ziehen, bleibt der Zustand erhalten.
- **Spielmodi**:
  - **X01** (301/501): Straight-, Double- oder Master-In und -Out, Bust-Regel, Legs („First to N“), Checkout-Vorschläge
  - **Cricket**: Standard oder Cut-Throat, Rundenlimit
- **Spielen**:
  - Bis zu 8 Spieler (du und Gäste), mit oder ohne Board
  - Manuelle Eingabe per Klick aufs Dartboard oder per Tastatur
  - Einzelnen Wurf korrigieren, Rückgängig, Weiter, Revanche, Spiel abbrechen
  - Score-Ansage im Browser („One hundred and eighty“)
- **Statistik**:
  - X01: 3-Dart-Average, First-9, Checkout-Quote, höchster Checkout, 180er, 140+ und 100+, bestes Leg
  - Cricket: MPR
  - Dazu Siegquote und Liste der letzten Spiele
- **Board-Verwaltung**: Start, Stopp, Reset, Kameras neu suchen, Erkennungsparameter einstellen, Erkennungstest ohne laufendes Spiel

Eine ausführliche Analyse von Autodarts und was davon (noch nicht) umgesetzt ist, steht in [`docs/AUTODARTS-FEATURES.md`](docs/AUTODARTS-FEATURES.md).

## Schnellstart

### 1. Server starten (beliebiger Rechner im Netz: NAS, Mini-PC, auch der Pi selbst)

```bash
cp .env.example .env          # JWT_SECRET setzen, z. B. openssl rand -hex 32
docker compose up -d --build
```

Danach `http://<server-ip>:3000` öffnen, ein Konto registrieren und anschließend in `.env` `ALLOW_REGISTRATION=false` setzen.

### 2. Board-Client auf dem Raspberry Pi 5

Voraussetzung: Raspberry Pi OS (64 Bit), Docker, 3 USB-Kameras (MJPEG-fähig, z. B. ELP/OV9732). Verteile die Kameras auf beide USB-Busse und nutze aktive Kühlung.

```bash
cd board
cp .env.example .env          # AUTODARTER_SERVER=http://<server-ip>:3000
docker compose up -d --build
docker compose logs -f        # zeigt den Kopplungscode
```

Die Statusseite `http://<pi-ip>:3180` zeigt Kopplungscode, Verbindung und Kamerabilder. Die Server-Adresse lässt sich dort ebenfalls ändern.

### 3. Board koppeln, Kameras montieren und kalibrieren

1. In der App unter **Boards → Board hinzufügen** den Code eingeben.
2. Kameras montieren: im 120°-Abstand rund um das Board, eine mittig über der **6** oder **11**, keine über der 20. Neigung etwa 35–55° zur Board-Oberfläche, mit LED-Ring gegen Schatten.
3. Auf der Board-Seite bei jeder Kamera **Kalibrieren** wählen und die 5 Punkte setzen, bis das grüne Raster genau auf den Drähten liegt.
4. Mit dem **Erkennungstest** auf der Board-Seite prüfen, ob die Würfe richtig erkannt werden.

### 4. Spielen

Unter **Spielen** 301 / 501 / Cricket wählen, Spieler hinzufügen, das Board auswählen und starten.

- Würfe erscheinen automatisch.
- Nach dem Ziehen der Darts ist der nächste Spieler dran.
- Ein falsch erkannter Wurf lässt sich antippen und korrigieren.

## So funktioniert die Erkennung

1. Jede Kamera vergleicht das aktuelle Bild mit einem Referenzbild (das Board vor dem Wurf). Ist das Bild wieder ruhig, wird die Änderung ausgewertet.
2. Die Fragmente des neuen Darts (Spitze, Barrel, Flight) werden gesammelt. Dabei hilft die Richtung der Board-Normalen im Bild, die aus der Kalibrierung berechnet wird (Kamerapose per Homographie-Zerlegung).
3. Die **Dart-Achse** wird auf dem schmalen Teil (Spitze und Barrel) gefittet, der breite Flight wird ausgeschlossen.
4. Über die Kalibrier-Homographie wird diese Achse auf die Board-Ebene abgebildet. Die Spitze liegt **garantiert auf dieser Linie**, auch wenn die dünne Stahlspitze im Bild nicht zu sehen ist.
5. Die Linien aller Kameras werden robust geschnitten: das beste konsistente Kamerapaar, danach Ausgleichsrechnung über alle passenden Kameras. Daraus ergeben sich Position (mm) und Segment.
6. Takeout: Eine große Änderung bedeutet „Hand am Board“. Wird das Bild danach wieder ruhig und hat sich etwas verändert, ist der Takeout beendet. Hat sich nichts verändert, bleibt der alte Zustand erhalten.

Ergebnis im Simulator mit 240 Würfen auf 3 Kameras (die Hälfte mit absichtlich 2 px Kalibrierfehler):

- Median-Fehler 0,75 mm, 95 % der Würfe unter 2,3 mm
- 95,4 % der Segmente korrekt; die Fehler liegen fast nur direkt an Drähten

Auf echter Hardware hängt die Genauigkeit vor allem von der Kalibrierung, der Beleuchtung und der Kameraposition ab.

## Entwicklung

```bash
# Tests
cd shared && npm install && npm test                  # Spiel-Engine (16 Tests)
cd board && pip install -r requirements.txt pytest && python -m pytest tests   # Erkennung mit Simulator

# Server lokal (braucht PostgreSQL)
cd server && npm install && DATABASE_URL=postgres://… JWT_SECRET=dev-secret-dev-secret npm run dev

# App (Web-Dev-Server, API woanders)
cd app && npm install && EXPO_PUBLIC_API_URL=http://localhost:3000 npm run web

# Board-Client OHNE Hardware: simuliertes Board mit 3 virtuellen Kameras
cd board && CAMERA_SOURCE=sim AUTODARTER_SERVER=http://localhost:3000 python -m autodarter_board
#   → auf http://localhost:3180 gibt es die Buttons „Sim: Dart werfen“ und „Sim: Darts ziehen“
```

Die App läuft mit Expo auch nativ auf iOS und Android (`npm run android` / `npm run ios`). Die Server-Adresse stellst du im Login-Bildschirm ein.

## Konfiguration

| Variable | Wo | Bedeutung |
|---|---|---|
| `JWT_SECRET` | Server | Pflicht, langes Zufalls-Secret |
| `ALLOW_REGISTRATION` | Server | `false` sperrt neue Registrierungen |
| `POSTGRES_PASSWORD`, `PORT` | Server | DB-Passwort und Port der Web-App |
| `AUTODARTER_SERVER` | Pi | z. B. `http://192.168.1.10:3000` |
| `CAMERA_SOURCE` | Pi | `v4l2` (echte Kameras) oder `sim` |
| `CAMERAS` | Pi | Optional: feste Geräte, z. B. `/dev/video0,/dev/video2,/dev/video4` |

Der Pi speichert seine Board-ID, das Board-Secret, die Kalibrierung (pro USB-Port) und die Einstellungen in `board/data/`.

## Grenzen und nächste Schritte

- Die Erkennung ist klassische Bildverarbeitung, kein neuronales Netz. Sie ist im Simulator validiert, aber **noch nicht an einem echten Board getestet**. Die Schwellwerte lassen sich in der App anpassen.
- Bounce-outs werden noch nicht gemeldet. Zwei Darts im selben Bewegungsfenster werden als einer gewertet.
- Es gibt noch keine Auto-Kalibrierung, keine Online-Lobbies zwischen Boards und keine weiteren Spielmodi (ATC, Shanghai, Bob's 27 …). Die event-basierte Engine ist aber darauf ausgelegt.
- Für den Zugriff von außen gehört ein Reverse-Proxy mit HTTPS vor den Server (z. B. Caddy oder Traefik).
