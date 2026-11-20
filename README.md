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
- **Ein Board, mehrere Konten (n:m)**:
  - Wer zuerst koppelt, ist Besitzer. Weitere Spieler fügen das Board mit dem aktuellen Code hinzu (steht auf der Board-Seite und am Pi), oder der Besitzer teilt es direkt mit Freunden. Der Code ändert sich nach jeder Verwendung.
  - **Sperre:** Läuft auf dem Board ein Spiel, kann niemand anderes ein neues starten („Board ist belegt: Maik spielt 501 …“). Andere können zuschauen. Mitspieler werden gefragt, ob sie das laufende Spiel beenden wollen. Nach 30 Minuten ohne Wurf (`BOARD_IDLE_MINUTES`) ist das Board wieder frei.
  - **Notausgang:** Auf der Board-Seite kann jeder, der das Board im Konto hat, ein hängendes Spiel mit „Spiel beenden“ abbrechen. Spiele ganz ohne Wurf seit 12 Stunden (`STALE_MATCH_HOURS`) beendet der Server selbst, damit keine „Spielleichen“ übrig bleiben.
  - Update, Pi-Neustart, Einstellungen, Name und Mitglieder verwaltet nur der Besitzer.
- **Freunde**:
  - Freunde per Benutzername suchen oder per Einladungslink (`/invite/<name>`) einladen.
  - Wer gerade online ist, siehst du live (grüner Punkt). Beim Spielstart werden Freunde, die online sind, als Mitspieler vorgeschlagen.
  - Spielen Freunde mit ihrem Konto mit, zählt das Spiel in ihrer Statistik, und sie bekommen sofort eine Einladung mit „Öffnen“.
  - **Freunde spielen gerade**: Läuft bei einem Freund ein Spiel, steht es oben auf „Spielen“. In der ersten Runde kannst du mit „Mitspielen“ noch einsteigen (du wirfst als Letzter der Runde, am Board des Spiels oder per „Remote spielen“ an deinem eigenen), danach kannst du zuschauen.
- **Kameras live ansehen**: Livebild aller Kameras in der App, mit eingeblendetem Board-Raster der Kalibrierung und der erkannten Dartspitze
- **Kamera-Ansicht im Spiel** wie bei Autodarts: *Virtuell · Kamera 1 · Kamera 2 · Kamera 3*. Das Kamerabild wird mit der Kalibrierung **entzerrt**, so dass das Board frontal erscheint (statt schräg von der Seite). Würfe werden darauf markiert, und du kannst auch dort zum Korrigieren tippen.
  - Die Markierungen sitzen in jeder Ansicht an der **Spitze** (dort, wo der Dart im Board steckt). Der Rest des Darts ragt aus dem Board und erscheint im entzerrten Bild deshalb als langer Strich, der von der Kamera weg zeigt.
  - Passen Bild und Markierungen in einer Kamera nicht zusammen (z. B. spiegelverkehrte Zahlen), ist ihre Kalibrierung falsch – siehe unten.
- **Status-Ring** um das Board: grün = werfen, orange = Darts ziehen, rot = Board offline/gestoppt
- **Kalibrieren** wie bei Autodarts: Pro Kamera ziehst du 4 Punkte auf die Außenkante des Doppelrings (20|1, 6|10, 3|19, 11|14), dazu einen 5. Punkt auf das Bull.
  - **Automatisch erkennen**: Der Pi sucht das Board selbst im Kamerabild und setzt die Punkte. Gibt es schon eine Kalibrierung (oder hast du die Punkte grob gesetzt), wird sie nur nachgezogen. Sonst fragt die App einmal, wo die 20 ist. Du prüfst das Netz und speicherst.
  - Das Board-Raster wird dabei live projiziert, dazu die **Sektorzahlen in Gelb**: Sie müssen auf den gedruckten Zahlen des Boards stehen. So fällt eine verdrehte Kalibrierung sofort auf.
  - **Spiegelverkehrt-Schutz**: Sind zwei Punkte vertauscht (z. B. „20 | 1“ mit „6 | 10“ und „3 | 19“ mit „11 | 14“), passt das Netz trotzdem perfekt auf die Drähte – aber jeder Dart dieser Kamera würde gespiegelt gezählt. Die App lässt so eine Kalibrierung nicht mehr speichern, „Automatisch erkennen“ übernimmt sie nicht und fragt nach der 20. Ist eine gespiegelte Kalibrierung schon gespeichert, ignoriert das Board diese Kamera und zeigt eine rote Warnung auf der Board-Seite und im Spiel.
  - Liegt eine Kamera bei vielen Würfen neben den anderen beiden, meldet das Board das ebenfalls („Kalibrierung prüfen“).
  - Zum Feinjustieren gibt es eine Lupe, Pfeiltasten und Pfeil-Buttons.
  - **Bleibt gespeichert**: pro USB-Anschluss auf dem Pi (`data/calibration.json`) und als Sicherung auf dem Server. Licht aus, Neustart, kurz abgezogene Kamera – die Kalibrierung bleibt, bis du sie selbst neu setzt. Verliert der Pi seinen `data`-Ordner, holt er sie sich vom Server zurück.
  - **Licht aus/an**: Im Dunkeln pausiert die Erkennung („Zu dunkel“), beim Einschalten wartet sie kurz, bis sich die Kameras eingeregelt haben. So entstehen keine Phantom-Darts.
  - Im Spiel gibt es über den **Schraubenschlüssel** (Technik) Reset, Neu kalibrieren, Kameras neu verbinden und Board-Client neu starten.
- **Automatische Erkennung**:
  - Würfe aus allen Kameras werden zusammengeführt.
  - Takeout (Hand am Board) wird erkannt und schaltet zum nächsten Spieler weiter.
  - Bewegt sich eine Hand am Board, ohne Darts zu ziehen, bleibt der Zustand erhalten.
  - **Abpraller und rausgefallene Darts** (offizielle Regel: zählt als geworfen, aber ohne Punkte):
    - Fällt ein Dart vor dem Ziehen aus dem Board – auch während der nächste einschlägt –, wird er nachträglich zu **Miss** („rausgefallen“), seine Markierung bleibt grau stehen.
    - Trifft ein Dart das Board und fällt sofort herunter, meldet das Board einen **Miss** („Abpraller“). Das lässt sich unter *Erkennungs-Einstellungen → Abpraller als Miss* abschalten, falls Bewegungen direkt vor dem Board fälschlich als Abpraller gezählt werden. Ein Dart, der das Board ganz verfehlt, ist für die Kameras oft unsichtbar – den bitte als Miss eintippen.
- **Spielmodi**:
  - **X01** (301/501): Straight-, Double- oder Master-In und -Out, Bust-Regel, Legs („First to N“), Checkout-Vorschläge
  - **Cricket**: Standard oder Cut-Throat, Rundenlimit
  - **Around the Clock**: 1 bis 20, optional zum Schluss das Bull. Varianten: ganze Zahl, nur Doubles oder nur Triples; auf Wunsch springen Double/Triple 2/3 Zahlen weiter
- **Spielen**:
  - Bis zu 8 Spieler (du, Freunde mit Konto und Gäste), mit oder ohne Board
  - Ein freies Board, das online ist, wird automatisch ausgewählt. Manuelle Eingabe nur, wenn keins da ist oder du sie wählst.
  - Manuelle Eingabe per Klick aufs Dartboard oder per Tastatur
  - Cricket: Nur die Zahlen, die noch im Spiel sind, sind auf dem Board grün hinterlegt und umrahmt. Alles andere ist ausgegraut.
  - Ohne Board bleibt die fertige Aufnahme mit allen drei Darts kurz stehen (ca. 2 s), dann ist automatisch der nächste Spieler dran.
  - Einzelnen Wurf korrigieren, Rückgängig, Weiter, Revanche, Spiel abbrechen
  - Ansage im Browser und in der iOS-/Android-App: X01 sagt die Punkte der Aufnahme an („One hundred and eighty“), Cricket und Around the Clock jeden Dart („Triple 20“, „Bullseye“)
  - **Eigene Stimmen** (Profil → Stimmen verwalten): Jeder kann Ansagen selbst einsprechen – nur die, auf die er Lust hat, z. B. 180, Big Fish (170er Checkout) oder Triple 20. Alles andere sagt die Standardstimme. Pakete lassen sich mit Freunden teilen.
    - Statt aufzunehmen kann man im Browser auch eine Audiodatei hochladen (z. B. ein Meme als MP3) und auf der Wellenform die passenden Sekunden auswählen (max. 10 s).
    - Beim Spielstart: „Jeder mit eigener Stimme“ (jeder Freund mit Konto hört seine Stimme aus dem Profil, Gäste die des Erstellers) oder „Alle mit meiner Stimme“. Unter jedem Namen lässt sich die Stimme auch einzeln festlegen.
  - **Remote spielen**: Standard ist, dass alle am Board des Spiels werfen. Ein Mitspieler kann im Spiel unter „Remote spielen“ stattdessen sein eigenes Board wählen (z. B. zu Hause). Gezählt wird immer das Board des Spielers, der gerade dran ist.
- **Statistik** mit Diagrammen und Vergleich mit Freunden (Zeitraum 7/30/90 Tage oder alles):
  - X01: Average-Verlauf, First-9, Punkteverteilung, Checkout-Quote und Trefferquote pro Double, 180er, 140+, 100+, höchster Checkout, bestes Leg
  - Cricket: MPR-Verlauf, Marks pro Aufnahme und pro Zahl
  - Around the Clock: Darts pro Spiel, Trefferquote
  - Trefferbild auf dem Board, Head-to-Head gegen Freunde, Siegquote, letzte Spiele
- **Board-Verwaltung**: Start, Stopp, Reset, Kameras neu suchen, Erkennungsparameter einstellen, Erkennungstest ohne laufendes Spiel

Eine ausführliche Analyse von Autodarts und was davon (noch nicht) umgesetzt ist, steht in [`docs/AUTODARTS-FEATURES.md`](docs/AUTODARTS-FEATURES.md).

## Lokal ausprobieren (ohne Pi und ohne Kameras)

Mit Docker (unter Windows z. B. in WSL) läuft der Server zusammen mit einem **simulierten Board**, das 3 virtuelle Kameras hat:

```bash
cp .env.example .env              # JWT_SECRET setzen
docker compose --profile demo up -d --build
```

1. `http://localhost:3000` öffnen und ein Konto registrieren.
2. Den Kopplungscode von `http://localhost:3180` unter *Boards → Board hinzufügen* eingeben.
3. Ein Spiel mit dem Board starten.
4. Auf `http://localhost:3180` mit **„Sim: Dart werfen“** und **„Sim: Darts ziehen“** spielen.

Unter WSL fährt Windows die Linux-VM herunter, wenn kein WSL-Fenster offen ist. Lass also beim Testen ein Terminal mit `docker compose logs -f` offen. Beenden mit `docker compose --profile demo down`.

## Server zu Hause, Pi woanders (z. B. in der Firma)

Server und Board müssen nicht im selben Netz stehen. **Der Pi baut die Verbindung immer selbst nach außen auf** (verschlüsselter WebSocket, `wss://` über Port 443). Am Standort des Pi muss deshalb kein Port geöffnet werden.

```
 Firma: Pi + Kameras ──wss:443──►  Internet  ──►  zu Hause: Caddy oder Cloudflare Tunnel ─► Autodarter-Server
 Browser/Handy (egal wo) ──https──┘
```

**Zu Hause** machst du den Server über HTTPS erreichbar. Wähle eine der beiden Varianten:

| Variante | Voraussetzung | Kosten |
|---|---|---|
| **A: Caddy + Let's Encrypt** (empfohlen bei **statischer IP**) | Öffentliche IPv4, Portfreigabe 80 und 443 im Router, ein kostenloser Name für die IP (z. B. `meindart.duckdns.org` bei [DuckDNS](https://www.duckdns.org)) | kostenlos |
| **B: Cloudflare Tunnel** | Eine **eigene Domain**, deren DNS bei Cloudflare liegt. Keine Portfreigabe nötig, funktioniert auch mit DS-Lite/CGNAT | Domain ca. 1–15 € pro Jahr |

Warum ein Name und nicht nur die IP?

- Ohne Namen ginge nur `http://<IP>:3000` ohne Verschlüsselung. Passwörter, Login-Token und das Board-Secret gingen dann im Klartext durchs Internet.
- Viele Gast-WLANs lassen außerdem nur die Ports 80 und 443 nach außen.
- Ein DuckDNS-Name zeigt einfach fest auf deine statische IP (einmal eintragen, kein Updater nötig). Caddy holt damit automatisch ein kostenloses Let's-Encrypt-Zertifikat.
- Let's Encrypt stellt seit 2026 auch Zertifikate direkt für IP-Adressen aus. Die sind aber nur 6 Tage gültig und brauchen besondere Client-Unterstützung, deshalb hier der Weg über den Namen.

**In der Firma** musst du nichts einrichten. Der Pi im Gast-WLAN braucht nur ausgehend Port 443, wie jeder Browser. Am Pi setzt du einmal die Adresse: `docker exec autodarter-board autodarter server https://meindart.duckdns.org`.

- Braucht das Netz einen Proxy, trägst du ihn in `HTTPS_PROXY` ein.
- Kläre vorab mit der IT, dass ausgehende Verbindungen auf Port 443 zu deiner Domain erlaubt sind.
- Bei Firmen-Proxys mit TLS-Inspektion muss das Firmen-Root-Zertifikat in den Container. Dazu mountest du es und setzt `SSL_CERT_FILE`.

Was die Verbindung übers Internet robust macht:

- **Würfe gehen nicht verloren.** Fällt die Verbindung kurz aus, puffert der Pi Würfe und Takeouts und liefert sie nach dem Reconnect nach (bis zu 3 Minuten alt).
- **Automatischer Reconnect** mit Backoff und Heartbeat alle 20 s. Das hält NAT- und Proxy-Verbindungen offen.
- **Kamerabilder** werden nur übertragen, solange jemand die Board-Seite offen hat. Bei langsamem Upload am Board senkst du `STREAM_FPS` und `STREAM_MAX_WIDTH` in der Server-`.env`.
- **Sicherheit:**
  - Login, Registrierung, Board-Kopplung und Board-Verbindungen sind gegen Durchprobieren begrenzt (HTTP 429).
  - Setze nach dem Anlegen deiner Konten `ALLOW_REGISTRATION=false`.
  - Die lokale Statusseite `:3180` am Pi ist nur im Netz am Standort des Pi erreichbar und kann den Pi nicht neu starten.

## Autostart und Neustart

- Alle Container haben `restart: unless-stopped`. Nach einem Stromausfall oder Neustart startet Docker sie automatisch, sobald Linux hochgefahren ist. Bei Docker aus `get.docker.com` ist der Dienst standardmäßig aktiviert (`sudo systemctl enable docker`).
- Der Server wartet beim Start auf die Datenbank, und der Board-Client verbindet sich selbst neu, wenn der Server später hochkommt oder kurz weg war. Board-ID und Kalibrierung bleiben in `board/data/` erhalten.
- Ausnahme: Container, die du vorher von Hand mit `docker compose stop` angehalten hast, bleiben auch nach einem Neustart aus.
- **Fernneustart aus der Web-App** (Board-Seite):
  - **„Board-Client neu starten“**: Die Software auf dem Pi beendet sich, Docker startet sie nach wenigen Sekunden neu.
  - **„Raspberry Pi neu starten“**: Der ganze Pi bootet neu, über systemd-logind auf dem D-Bus des Hosts. Das musst du bewusst freigeben: `ALLOW_REBOOT=true` in `board/.env`. Der Button ist nur aktiv, wenn der Pi die Freigabe meldet.
  - Dazu kommen Start, Stopp, Reset und „Kameras neu suchen“ für die Erkennung.

## Updates: fertige Images und Auto-Update

Bei jedem Push auf `main` baut GitHub Actions ([`.github/workflows/images.yml`](.github/workflows/images.yml)) die Images für **x86 (Server/PC) und arm64 (Pi 5)** und legt sie in die GitHub Container Registry:

Aktuell liegen die Images öffentlich auf **Docker Hub**:

| Image | Plattform | Wofür |
|---|---|---|
| `maik05/autodarter-server` | linux/amd64 | Server mit Web-App (Heimserver) |
| `maik05/autodarter-server-board` | linux/arm64 | Board-Client mit Kamera-Erkennung (Raspberry Pi 5) |
| `maik05/autodarter-updater` | amd64 + arm64 | Auto-Update für beide |

Tags: `latest` und die Version (z. B. `0.2.0`). Neu bauen und hochladen kannst du von einem Rechner mit Docker aus (siehe *Entwicklung*).

Der GitHub-Workflow kann die Images alternativ in die GitHub Container Registry legen:

| Image | Tags |
|---|---|
| `ghcr.io/<github-user>/autodarter-server` | `latest` (jeder Stand von `main`), `stable` + `1.2.3` (Release-Tags `v1.2.3`), `sha-abc1234` (jeder Build, zum Festnageln/Zurückrollen) |
| `ghcr.io/<github-user>/autodarter-server-board` | wie oben |
| `ghcr.io/<github-user>/autodarter-updater` | wie oben |

Server und Pi ziehen sich dann neue Versionen **selbst**. Dafür setzt du in der jeweiligen `.env`:

```bash
AUTODARTER_REGISTRY=ghcr.io/<github-user>
AUTODARTER_TAG=latest              # oder stable = nur Releases
COMPOSE_PROFILES=autoupdate        # Server mit Tunnel z. B.: tunnel,autoupdate
```

Danach einmal `docker compose pull && docker compose up -d` ausführen. Ab dann musst du dich nicht mehr per SSH verbinden:

- Der Updater-Container prüft alle 6 Stunden (`UPDATE_INTERVAL`), optional nur in einem Zeitfenster wie `UPDATE_HOURS=3-6`.
- Er zieht neue Images und erstellt **nur die Container neu, deren Image sich geändert hat**. Daten bleiben in Volumes bzw. `board/data/`.
- **Nie mitten im Spiel:** Wurde in den letzten 15 Minuten geworfen, wartet er.
- In der App gibt es auf der Board-Seite **„Software aktualisieren“** (Pi, nur für den Besitzer) und im Profil **„Server aktualisieren“** (Server, nur für Admins: `ADMIN_USERS` bzw. das erste Konto). Damit wird sofort geprüft.
- Ist das Repository privat, führst du auf dem Server bzw. Pi einmal `docker login ghcr.io` aus, mit einem GitHub-Token, das `read:packages` darf. Der Updater nutzt diesen Login.
- Rollback: `AUTODARTER_TAG=sha-<vorheriger-commit>` setzen und `docker compose up -d` ausführen.
- Ab Version 0.3.0 aktualisiert sich der Updater auch selbst. Läuft noch ein älterer Updater (0.2.0), einmal von Hand: `docker compose pull && docker compose up -d`.

Ist das bei so einer Anwendung üblich? Für Heimserver und „Geräte“ wie den Pi ja. Bekannt ist das Prinzip von Watchtower, das aber seit Ende 2025 nicht mehr gepflegt wird. Wichtig sind drei Dinge, und die sind hier umgesetzt: Daten außerhalb der Container, kein Update während der Nutzung, Zurückrollen per Tag. Willst du lieber kontrolliert ausrollen, nimm `AUTODARTER_TAG=stable` und setze Release-Tags nur für geprüfte Stände.

## Wo hosten? (Vercel oder zu Hause)

Der Server braucht **dauerhaft laufende WebSocket-Verbindungen** (Pi ↔ Server, App ↔ Server), Zustand im Speicher (verbundene Boards, laufende Spiele) und PostgreSQL. Serverless-Plattformen wie **Vercel** passen dazu nicht:

- Funktionen laufen dort maximal wenige Minuten. Danach wird auch ein WebSocket getrennt, und ein Reconnect landet evtl. auf einer anderen Instanz ohne den Zustand.
- Datenbank und Board-Verbindung müssten auf externe Dienste umgebaut werden.
- Kostenlos ginge es auch nicht: Solange eine Verbindung offen ist, zählt der Speicher der Funktion. Der dauerhaft verbundene Pi verbraucht im Hobby-Tarif (2 GB × 720 h ≈ 1440 GB-h, frei sind 360 GB-h) das Freikontingent nach etwa einer Woche.

Zu Hause (x86-Linux mit Docker) plus **Cloudflare Tunnel** ist für ein Board und ein paar Spieler die einfachste und günstigste Lösung. Es läuft nichts in fremden Clouds, und es gibt keine offenen Ports. Wenn der Rechner zu Hause nicht durchläuft, ist ein kleiner VPS (z. B. 2 vCPU/4 GB) die Alternative, mit identischem `docker compose`.

Datenverbrauch (grobe Werte, 1 Board, 4 Spieler):

| Was | Datenmenge |
|---|---|
| Spielen ohne Kamerabild (Würfe, Spielstand, Status) | wenige MB pro Stunde |
| Kamera-Ansicht im Spiel (1 entzerrtes Bild, 4 FPS) | ca. 0,3–0,5 GB pro Stunde und Zuschauer |
| Board-Seite mit allen 3 Kameras | ca. 1–1,5 GB pro Stunde |
| Web-App laden (einmalig, danach Browser-Cache) | ca. 2–3 MB |

Kamerabilder fließen nur, solange jemand sie anschaut. `STREAM_FPS` und `STREAM_MAX_WIDTH` senken den Verbrauch weiter.

## Schnellstart

### 1. Server starten (Heimserver, x86 Linux mit Docker)

Das fertige Image liegt öffentlich auf Docker Hub (`maik05/autodarter-server`). Ohne git, per SSH:

```bash
mkdir -p ~/autodarter-server && cd ~/autodarter-server
docker run --rm maik05/autodarter-server cat /app/compose.yml > docker-compose.yml
printf 'JWT_SECRET=%s\nPOSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -hex 16)" > .env
docker compose up -d
```

Danach `http://<server-ip>:3000` im Heimnetz öffnen und die Konten eurer Gruppe registrieren. Fürs Internet (Variante A oben), erst den DuckDNS-Namen anlegen und im Router 80 und 443 auf den Server weiterleiten, dann:

```bash
echo 'DOMAIN=meindart.duckdns.org' >> .env
echo 'COMPOSE_PROFILES=https,autoupdate' >> .env
echo 'ALLOW_REGISTRATION=false' >> .env        # sobald alle Konten angelegt sind
docker compose up -d
```

Ab dann läuft alles über `https://meindart.duckdns.org`, für Browser, Handy-App und Pi. `autoupdate` holt neue Versionen von Docker Hub nachts zwischen 3 und 6 Uhr, nie während eines Spiels.

Aus dem Repository geht es auch: `cp .env.example .env && docker compose up -d --build`.

### 2. Board-Client auf dem Raspberry Pi 5

Voraussetzung: Raspberry Pi OS (64 Bit), Docker, 3 USB-Kameras (MJPEG-fähig, z. B. ELP/OV9732). Verteile die Kameras auf beide USB-Busse und nutze aktive Kühlung.

Die fertigen Images liegen öffentlich auf Docker Hub (`maik05/autodarter-server-board`, für den Pi gebaut: arm64). Auf dem Pi brauchst du weder git noch einen Monitor, alles läuft per SSH:

```bash
mkdir -p ~/autodarter && cd ~/autodarter
docker run --rm maik05/autodarter-server-board autodarter compose > docker-compose.yml
docker compose up -d
docker exec autodarter-board autodarter server https://<deine-domain>   # einmal, wird gespeichert
docker exec autodarter-board autodarter                                  # Status + Kopplungscode
```

Weitere Befehle für den Pi ohne Bildschirm:

| Befehl | Wirkung |
|---|---|
| `docker exec autodarter-board autodarter code` | nur den Kopplungscode ausgeben |
| `docker exec autodarter-board autodarter` | Server, Verbindung, Code, Erkennung und Kameras |
| `docker logs autodarter-board` | der Code steht als großer Block im Log und wird alle 5 Minuten wiederholt, solange das Board noch in keinem Konto ist |
| `docker exec autodarter-board autodarter restart` | Board-Client neu starten |

Optionale Einstellungen (`ALLOW_REBOOT=true`, `COMPOSE_PROFILES=autoupdate`, `HTTPS_PROXY=…`) trägst du in eine `.env` neben der `docker-compose.yml` ein, danach `docker compose up -d`. Die Statusseite `http://<pi-ip>:3180` gibt es weiterhin, sie ist aber nicht mehr nötig.

Mit dem Repository auf dem Pi geht es auch: `cd board && cp .env.example .env && docker compose up -d --build`.

### 3. Board koppeln, Kameras montieren und kalibrieren

1. In der App unter **Boards → Board hinzufügen** den Code eingeben.
2. Kameras montieren: im 120°-Abstand rund um das Board, eine mittig über der **6** oder **11**, keine über der 20. Neigung etwa 35–55° zur Board-Oberfläche, mit LED-Ring gegen Schatten.
3. Auf der Board-Seite bei jeder Kamera **Kalibrieren** wählen und **Automatisch erkennen** drücken (oder die 5 Punkte von Hand setzen), bis das grüne Raster genau auf den Drähten liegt. Dann speichern.
4. Mit dem **Erkennungstest** auf der Board-Seite prüfen, ob die Würfe richtig erkannt werden.

### 4. Spielen

Unter **Spielen** 301 / 501 / Cricket / Around the Clock wählen, Spieler hinzufügen, das Board auswählen und starten.

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
7. Rausgefallen: Zeigen die Pixel eines Darts dieser Aufnahme wieder das leere Board, ist er herausgefallen. Diese Stelle zählt auch nicht als neuer Dart.
8. Abpraller: Eine kurze, dart-große Bewegung, die mindestens zwei Kameras sehen und die nichts im Board hinterlässt (nicht direkt nach dem Ziehen).

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

# Images bauen und zu Docker Hub hochladen (einmal: docker login; arm64 braucht QEMU:
#   docker run --privileged --rm tonistiigi/binfmt --install arm64)
docker buildx build --platform linux/amd64 -f server/Dockerfile -t maik05/autodarter-server:latest --push .
docker buildx build --platform linux/arm64 -t maik05/autodarter-server-board:latest --push board
docker buildx build --platform linux/amd64,linux/arm64 -t maik05/autodarter-updater:latest --push updater

# Board-Client OHNE Hardware: simuliertes Board mit 3 virtuellen Kameras
cd board && CAMERA_SOURCE=sim AUTODARTER_SERVER=http://localhost:3000 python -m autodarter_board
#   → auf http://localhost:3180 gibt es die Buttons „Sim: Dart werfen“ und „Sim: Darts ziehen“
```

Die App ist eine Codebasis für **Website, iOS, Android, Tablet und PC**:

- Im Browser liefert sie der Server aus.
- Nativ läuft sie mit Expo (`npm run android` / `npm run ios`, oder als Build über EAS). Die Server-Adresse stellst du im Login-Bildschirm ein.
- Das Layout passt sich der Breite an: Ab 900 px (Tablet quer, PC) stehen Spielstand und Board nebeneinander, darunter untereinander. Hoch- und Querformat sind erlaubt.

## Konfiguration

| Variable | Wo | Bedeutung |
|---|---|---|
| `JWT_SECRET` | Server | Pflicht, langes Zufalls-Secret |
| `ALLOW_REGISTRATION` | Server | `false` sperrt neue Registrierungen |
| `POSTGRES_PASSWORD`, `PORT` | Server | DB-Passwort und Port der Web-App |
| `BOARD_IDLE_MINUTES` | Server | Nach so vielen Minuten ohne Wurf darf ein anderer das Board übernehmen (Standard 30) |
| `STALE_MATCH_HOURS` | Server | Laufende Spiele ohne Wurf seit so vielen Stunden werden automatisch beendet (Standard 12) |
| `ADMIN_USERS` | Server | Benutzernamen, die den Server aus der App aktualisieren dürfen (Komma-getrennt). Leer = das zuerst angelegte Konto |
| `AUTODARTER_SERVER` | Pi | z. B. `http://192.168.1.10:3000` |
| `CAMERA_SOURCE` | Pi | `v4l2` (echte Kameras) oder `sim` |
| `CAMERAS` | Pi | Optional: feste Geräte, z. B. `/dev/video0,/dev/video2,/dev/video4` |
| `AUTODARTER_REGISTRY`, `AUTODARTER_TAG` | beide | Fertige Images, z. B. `ghcr.io/<github-user>` und `latest` / `stable` / `sha-…`; leer = lokal bauen |
| `COMPOSE_PROFILES` | beide | z. B. `autoupdate` (Pi) oder `tunnel,autoupdate` (Server) |
| `UPDATE_INTERVAL`, `UPDATE_HOURS`, `TZ` | beide | Auto-Update: Prüfintervall in Sekunden, optionales Zeitfenster wie `3-6` |

Der Pi speichert seine Board-ID, das Board-Secret, die Kalibrierung (pro USB-Port) und die Einstellungen in `board/data/`.

## Grenzen und nächste Schritte

- Die Erkennung ist klassische Bildverarbeitung, kein neuronales Netz. Sie ist im Simulator validiert, aber **noch nicht an einem echten Board getestet**. Die Schwellwerte lassen sich in der App anpassen.
- Zwei Darts im selben Bewegungsfenster werden als einer gewertet. Ein Dart, der das Board komplett verfehlt, wird meist nicht gesehen.
- Es gibt noch keine weiteren Spielmodi wie Shanghai oder Bob's 27. Die event-basierte Engine ist aber darauf ausgelegt.
- Neue Boards können sich ohne Login am Server melden (sie erscheinen erst nach der Kopplung in einem Konto). Unbenutzte, nicht gekoppelte Boards werden nach 30 Tagen gelöscht.
