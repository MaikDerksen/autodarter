# Autodarts – Funktionsanalyse (Recherche-Stand: 06.11.2026)

Ziel: Überblick, was das kommerzielle System "Autodarts" (autodarts.io → heute autodarts.com, play.autodarts.com) kann, als Vorlage für Autodarter.
Begriffe: "0.x" = alter Board-Client mit Browser-Board-Manager; "v2" = neuer Client (Autodarts Desktop bzw. Headless-Terminal-UI). Alles mit "(unbestätigt)" ist nicht offiziell belegt.

## 0. Kontext / Unternehmen

- Sept. 2025: Nodor Group (Mutterkonzern von Winmau und Red Dragon) übernimmt Autodarts.
- Sept. 2026 (IFA Berlin): Winmau startet das "Autodarts-Ökosystem": kostenlose App (Web, iOS, Android; EN/DE/NL), LENS (Handy-Autoscoring), Hardware "Autodarts X", Abo "Autodarts Plus".
- Laut Autodarts: über 200.000 registrierte Nutzer, ca. 40.000 Leute auf dem Discord, über 3,3 Mrd. gezählte Darts, offizieller Ausrüster der PDC.
- Domains: `autodarts.io` leitet per 301 auf `autodarts.com` um. Die DIY-Doku ist von `docs.autodarts.io` nach `autodarts.diy` umgezogen, neue Nutzer-Doku liegt auf `docs.autodarts.com`.
- Die Board-Software ist eine Closed-Source-Binary; es gibt kein Open-Source-Kernstück.

## 1. Hardware

### DIY-Setup (klassisch)
- **Board**: normale Steeldartscheibe plus 360°-LED-Ring gegen Schattenwurf: Winmau Plasma, Target Corona oder Eigenbau.
- **Kameras**: 3 USB-Webcams (UVC).
  - Empfehlung: FOV 80–110°, keine oder kaum Verzeichnung, stabile Bildrate von etwa 30 fps, geringer Stromverbrauch, kurze Kabel.
  - Auflösung 640x480 bis 1280x720. Höhere Auflösungen bringen laut Doku keinen Genauigkeitsgewinn; bei USB-Problemen auf 800x600 runtergehen.
  - Empfohlene Modelle: OV9732 (100°, leichte Verzeichnung), ELP OTG HD 5MP (100°, verzeichnungsfrei, manuelle Settings), MOERTEK MC920 (85°, Autofokus).
  - Inkompatibel: Rollei R-Cam 100, Makoty Webcam, GuangTouL Webcam.
- **Montage** (FAQ und Community-Doku):
  - Die Kameras stehen 120° auseinander; eine Kamera mittig über dem Segment 6 oder 11. Keine Kamera über der 20, weil Darts dort die Sicht verdecken.
  - Optische Achse 35–55° zur Board-Oberfläche.
  - Beispiel-Setup: ca. 30 cm Abstand zur Wand, ca. 36 cm zum Bull, 65°-FOV (Community). Oft wird direkt am LED-Ring montiert (STL-Halter für den Winmau Plasma gibt es).
- **Rechner**:
  - Minimum: 2×2,0 GHz oder 4×1,5 GHz, 1 GB RAM, 1 GB Speicher, 3 USB-Ports verteilt auf mindestens 2 USB-Busse (Bandbreite).
  - Stufen: Basic (Raspberry Pi OS, nur Board-Client); Intermediate (4×2,4 GHz, 4 GB RAM, bis zu 2 Extensions); Professional (i3/Ryzen ab 2018, über 8 GB RAM, Board-Client, Monitor und bis zu 4 Extensions).
  - Raspberry Pi 5 ist getestet, auch mit Monitor, aber nur mit Original-Netzteil und aktiver Kühlung. Pi 4 mit Monitor wird nicht empfohlen. Früher liefen auch Jetson Nano und Pi 3B+.
  - OS: vor allem Linux (Ubuntu/Debian, Raspberry Pi OS); Windows/macOS sind Beta/Alpha. Headless-Builds gibt es für x86_64, arm64 und armv7l.
  - "UVC Hack" (Linux-Skript) gegen USB-Bandbreitenprobleme, wenn nur 2 von 3 Kameras laufen. Er funktioniert nicht mit Secure Boot.

### Offizielle Hardware-Produkte
- **DIY Camera Kit**: 3 Kameras mit "Autodarts-Firmware", an einem einzigen USB-Port über ein Splitter-Kabel; ohne Halterungen. Preis ca. 89 € (unbestätigt, nur Suchergebnis).
- **Vision Kit / Autodarts Vantage**: 3 Kameras; die Arme ersetzen die Füße eines Winmau-Plasma-Rings (Plasma separat). Braucht weiterhin PC oder Raspberry Pi; kein Abo nötig. Ca. 199 € (Vision Kit) bzw. 200–250 £ (Vantage), laut Händlern.
- **Autodarts X** (Winmau, Auslieferung ab Nov. 2026):
  - 4 HD-Kameras ("PinPoint Detection"), integrierter 360°-LED-Ring (4000 K, diffus), eigene Recheneinheit.
  - Dual-Band-WLAN plus USB-C (für das Pairing oder als Kabelverbindung). Klemmmontage mit 4 Federklemmen ohne Bohren; Maße 800 mm Ø × 280 mm.
  - Ca. 449 £ (Argos); 2 Jahre Garantie; 3 Monate Plus inklusive. Funktioniert nur mit Autodarts-Account, nicht als Standalone-Gerät.
- **LENS**: Autoscoring mit der Kamera eines einzelnen Handys oder Tablets, nur in der Mobile-App. Free: 5 Matches pro 30 Tage; mit Plus unbegrenzt.
- **Genauigkeit**: laut Winmau-Vertreter ca. 90 % (LENS) bzw. ca. 99 % (Autodarts X); Herstellerangaben generell über 99 %.

## 2. Board-Client / Board Manager

### Betrieb
- **0.x**: Die Binary `autodarts` stellt den Board Manager als lokale Web-UI auf **Port 3180** bereit (`http://<pi-ip>:3180`). Im Config-Tab trägt man Board-ID, API-Key und die USB-Geräte-IDs ein (z. B. mit `v4l2-ctl --list-devices` ermittelt).
- **v2**: Board Manager im Browser wird nicht mehr unterstützt. Stattdessen:
  - **Autodarts Desktop** (Win/Mac/Linux) mit den Bereichen Home, Vision (Debug-Ansicht) und Configuration.
  - **Headless**: Installation per `curl -fsSL https://autodarts.sh | bash -s -- --headless` (optional `--beta`). Danach öffnet `autodarts` eine Terminal-UI; `autodarts remote` steuert ein Board im LAN; `autodarts update` aktualisiert.
  - Systemd-Dienste: `autodarts` und `autodartsupdater`. Config liegt in `~/.config/autodarts`.
- **Desktop-Statusleiste**: Status mit Restart/Stop/Reset, FPS gesamt und pro Kamera, RAM- und CPU-Last, Client-Version, Version der Detection-Software, Log-Ansicht.
- Option "Automatic Detection Updates": Die Detection wird getrennt vom Client versioniert und aktualisiert.
- Update-Zwang: v0.25.0 war ein serverseitig erzwungenes Sicherheitsupdate; ältere Clients konnten sich danach nicht mehr verbinden.

### Zustände (States)
- **Board State** (0.x Board Manager): Throw (wartet auf Dart), Throw detected, Takeout (3 Darts erkannt), Takeout started (Hand erkannt), Takeout finished.
- **Detection State** (Debug): Wait, Stable, Empty, Dart, Hand, Partial Takeout, Takeout.
- **Anzeige im Spiel** (Web-App): Offline, Stopped, Throw, Takeout (Darts ziehen), Takeout in progress.
- **Lokale Event-Codes** (aus dem Community-ESP32-Client):
  - Status: STOPPED=0, STARTING=2, THROW=8, TAKEOUT=16, TAKEOUT_PROGRESS=32.
  - Events: Stopped, Stopping, Starting, Started, Throw detected, Takeout started, Takeout finished, Manual reset.
- **Cloud-Board-Events** (darts-caller): `Takeout started`, `Takeout finished`, `Manual reset`, `Started`, `Stopped`, `Calibration started`, `Calibration finished`.

### Steuerung
- Buttons: Start/Stop, Reset, Connect/Disconnect (0.x); Restart, Stop und Reset (v2). Was Reset genau zurücksetzt, ist nicht dokumentiert; vermutlich die erkannten Darts, danach wieder Throw (unbestätigt).
- Lokale REST-API des 0.x-Clients (von darts-caller genutzt, nicht offiziell dokumentiert):
  - `PUT /api/detection/start`, `PUT /api/detection/stop`, `POST /api/reset`, `POST /api/config/calibration/auto`
  - WebSocket `ws://<host>/api/events`
- Die Board-IP im LAN wird an die Cloud gemeldet: `GET api.autodarts.io/bs/v0/boards/<id>` liefert das Feld `ip`.
- **Standby**: Nach einer einstellbaren Zeit ohne Aktivität stoppt das Board.

### Kamera-Ansichten (0.x-Tabs bzw. v2 "Vision")
- **Monitor**: virtuelles Board oder Livebild, zwischen den 3 Kameras umschaltbar. **Live**: alle 3 Kamerastreams.
- **Motion**: virtuelles Board mit rot markierter Bewegung. Normal grün; gelb heißt, die Takeout-Erkennung wurde ausgelöst.
- **Movement**: Bewegung im Vergleich zum letzten Bild. **Dart**: erkannte Darts, eine Zeile pro Dart.
- **Config** und **Distortion**: siehe unten.

### Kamera-Einstellungen
- Pro Kamera: Gerät, Auflösung, FPS, Standby-Zeit, Bild um 180° drehen.
- Statusleiste 0.x: FPS Lock, FPS pro Kamera, Auflösung.

### Kalibrierung
- **Manuell (0.x)**:
  - Pro Kamera 4 gelbe Marker auf die äußere Doppelring-Linie ziehen, an den Segmentgrenzen **20/1, 6/10, 3/19, 11/14** (Community-Doku; die offizielle Doku sagt nur "gelbe Marker in die richtige Reihenfolge ziehen").
  - Danach blendet ein Button das Segment-Overlay ein; das Ergebnis pro Kamera speichern.
- **Auto**:
  - Der Button "Auto" kalibriert automatisch; seit v0.26.0 mit **81 Keypoints** statt 4. Optional automatisch beim Start (Default aus).
  - Der Kalibrierstatus wird an den Server gemeldet; eine Kalibrierung lässt sich auch aus "My Boards" oder während eines Matches in der Web-App auslösen.
- **v2 Desktop**:
  - Automatische Kalibrierung aller Kameras (globaler Schalter "automatic calibration" und Button "Calibrate") oder pro Kamera (Zauberstab).
  - Prüfen, ob das Feld "20" rot markiert ist; sonst per Pfeiltasten um ein Feld nach links oder rechts verschieben.
- **Verzeichnung (Distortion)**:
  - Ab v0.24.0 korrigiert der Algorithmus Linsenverzeichnung automatisch. "Approximate distortion" steht seit v0.26.0 standardmäßig auf aus.
  - Vorher bzw. optional: Distortion-Tab mit einem gedruckten OpenCV-Schachbrett (25×25), das man im blauen Ellipsenbereich bewegt, bis 95 % Abdeckung erreicht sind; dann speichern. Bei OV9732, MC920 und ELP 5MP nicht nötig.

### Erkennungsverhalten
- **Takeout**: Nach 3 Darts wechselt das Board auf Takeout. Erkennt es eine Hand bzw. große Bewegung, folgt "Takeout started"; ist das Board danach leer, "Takeout finished" und zurück zu Throw. Teilweises Ziehen erkennt es als "Partial Takeout".
- v0.23: Hintergrundmaske (Änderungen außerhalb des Boards werden ignoriert) und robustere Handerkennung bei Wackeln. v0.26: zuverlässigere Takeout-Auslösung.
- Wackelnde Kamerahalter (z. B. Stativ) führen offenbar zu einem dauerhaften "Takeout in progress" (unbestätigt, Reddit-Post laut Suchergebnis).
- **Bounce-outs**: werden nicht automatisch erkannt (unbestätigt). In der Match-API hat ein Wurf den Typ `normal` oder `bouncer`; Korrekturen laufen per `PATCH /gs/v0/matches/<id>/throws` mit Koordinaten `{x,y}` und Typ.
- **Korrekturen**: manuell in der Web-App, im Plus-Abo per AI Referee (siehe 4). Ein Wurf wird als Segment `{name, number, multiplier, bed}` plus Koordinaten `{x,y}` gespeichert.

### Board ↔ Account
- **0.x**: Auf play.autodarts.io unter "My Boards" ein Board anlegen; man bekommt Board-ID und API-Key, die man im Board Manager einträgt. Auf der Board-Kachel gibt es einen Link zum Board Manager.
- **v2**:
  - Login per Browser bzw. OAuth Device Flow (QR-Code oder angezeigte URL und Code).
  - Danach "Create Board" oder "Claim Board". Claim übernimmt ein bestehendes Board und meldet es auf anderen Geräten ab.
- Bis zu 5 Geräte stehen unter "My Devices"; das Board wählt man in der Lobby im Panel "Autoscoring" aus.
- **Teilen**: Das Board-Objekt hat eine `permissions`-Liste mit Usern, Boards können also wohl mehreren Accounts zugeordnet werden (unbestätigt). Gäste spielen lokal mit oder treten der Lobby per QR-Code mit eigenem Account bei.
- **Cloud-API** (aus der Community, inoffiziell):
  - Auth über Keycloak (`login.autodarts.io`, Realm `autodarts`, Client `autodarts-app`).
  - REST unter `api.autodarts.io`: `/gs/v0` (Lobbies, Matches, Throws, `undo`, `players/next`, `games/next`), `/bs/v0` (Boards), `/as/v0` (User, Stats).
  - WebSocket `wss://api.autodarts.io/ms/v0/subscribe` (Ticket über `/ms/v0/ticket`).
  - Channels: `autodarts.boards` (`<board>.events`, `.matches`), `autodarts.matches` (`<match>.state`, `.game-events`), `autodarts.lobbies`, `autodarts.users`.

## 3. Erkennungsansatz (soweit öffentlich)

- **Bis v0.22 klassische CV** (dokumentierte Config-Parameter):
  - Differenzbild vorher/nachher mit Threshold, danach Gauß-Blur (Kernel 3 bzw. 5).
  - Blobs nach Pixelgröße klassifiziert: Dart min/max, Hand ab einer Mindestgröße.
  - ROI um die Blobs; **Hough-Linien** (Threshold ~50, Min Line Length, Max Line Gap) zur Erkennung des Dart-Schafts.
  - Bewegungserkennung auf reduzierter Auflösung (Scale 3; auf dem Raspberry Pi wird 4 empfohlen).
- **Ab v0.23**: Die Parameter wurden entfernt; danach ist der Ansatz undokumentiert.
  - Auto-Kalibrierung mit 81 Keypoints und Occlusion-Behandlung (v0.26) sprechen für ein gelerntes Modell, etwa einen Keypoint-Detektor (unbestätigt).
  - Die Detection läuft separat versioniert ("Detection-Software-Version") und wird automatisch aktualisiert.
- **Pro Kamera vs. Fusion**: Wie die Kameras fusioniert werden, ist nicht öffentlich.
  - Plausibel: Jede Kamera ermittelt Schaftlinie bzw. Spitze im Bild, die Homographie aus der Kalibrierung bildet sie auf Board-Koordinaten ab, dann werden die Kameras kombiniert (unbestätigt).
  - Der Client liefert Board-Koordinaten `{x,y}` plus Segment.
- Die Erkennung läuft **lokal** auf dem Board-Rechner; Scoring, Spiellogik und Stats laufen in der **Cloud**.
- Der AI Referee wertet Videoaufnahmen des Wurfs aus. Die Statusseite listet "Live Streaming" als Board-Komponente, Kamerabilder gehen also ins Netz (Umfang unbestätigt).

## 4. Web-App / Spielfunktionen

### Spielmodi und Optionen
- **X01**:
  - Startwert 121/170/301/501/701/901. In-Modus und Out-Modus jeweils Straight/Double/Master.
  - Bull-Off Off/WDF/PDC (alte Doku: Off/Normal/Official). Bull-Modus 25/50 oder 50/50. Max Rounds 15/20/50/80.
  - Match Mode Off/Legs/Sets mit "First to N"; bei Sets gibt es zusätzlich eine Option "Gewinn mit 2 oder 3" (Bedeutung unklar, unbestätigt). Referee Off/Enabled (Plus).
  - Bust bei unter 0 oder Rest 1; Score wird auf den Rundenbeginn zurückgesetzt.
- **Cricket**: Varianten Cricket (15–20 und Bull), Tactics (10–20 und Bull), Hidden Cricket (7 zufällige, verdeckte Zahlen); Wertung Standard/Cut Throat/No Score; Max Rounds, Match Mode, Bull-Off, Referee; Schachuhr (seit App 1.3.1).
- **Around the Clock**: Modus Full/Outer Single/Single/Double/Triple; Reihenfolge 1-20-Bull/20-1-Bull/Random-Bull; 1–3 Treffer pro Feld.
- **Round the World**: Reihenfolge wie ATC; jedes Feld zählt einmal mit Punkten.
- **Shanghai**: Segmente 1–20 oder 1–7.
- **Bermuda**: 13 Runden mit festen Zielen (12, 13, 14, Double, 15, 16, 17, Triple, 18, 19, 20, Bull, Bullseye).
- **Gotcha**: X01 rückwärts, von 0 bis zum Zielwert; Out-Modus, Max Rounds; mindestens 2 Spieler.
- **Count Up**: Max Rounds, höchste Punktzahl gewinnt.
- **Random Checkout**: Checkout min/max, Out-Modus, Max Rounds.
- **Segment Training**: Modus Single/Outer Single/Double/Triple/Random; Segment wählbar; Ende nach 5 Treffern oder nach 33/66/99 Darts.
- **Bob's 27**: Normal oder Allow Negative Score; Reihenfolge 1-20-Bull oder 1-20; nur solo.
- **Plus-only**: **Killer** (Standard/Blind Killer; Hit Mode Normal/Trebles/Doubles; Straight Off; 3–6 Leben; Max Rounds 15–50) und **121 Checkout** (Regeln nicht dokumentiert).
- Alle Modi außer Bob's 27, Gotcha und Killer sind auch solo spielbar.

### Lobbies und Online
- **Custom Lobby**:
  - Public (im Lobby-Tab sichtbar) oder Private; Einladungslink; QR-Code, über den Mitspieler mit eigenem Account beitreten.
  - Lokale Spieler per Name oder Bots ("Add Bot", Stärke als Punkte pro Runde, Feld `cpuPPR`; Bot-Tempo einstellbar).
  - Board-Auswahl in der Lobby; Chat in Lobby und Match (App 1.3.0).
- **Matchmaking**:
  - Aktuell nur 501 SIDO, Best of 3 oder Best of 5; Gegner nach Skill, das Suchfenster wird mit der Zeit größer.
  - Referee-Queue getrennt (nur Plus); Ready-Check vor dem Match. Timer: 30 min pro Match, 3 min pro Zug.
  - Strafsperren bei Ablehnen oder Abbrechen: von 5 min bis 24 h, rollierend über 24 h.
  - Seit App 1.3.1 "Online"-Tab mit Quick Match und filterbaren öffentlichen Lobbies.
- **Turniere**:
  - Automatisch geplant, mehrmals täglich (meist nach MEZ getaktet), aktuell nur 501 SIDO (Ausnahme "Grand Double Trouble" mit DIDO).
  - First to 1/2/3 Legs; Einschränkungen nach Average (z. B. unter 40 oder 50+).
  - KO-Baum mit 4–32 Spielern und Freilosen; 5 min Ready-Frist, sonst Forfeit.
  - Ranking-Ansicht mit Avg, Avg bis 170, First 9, CO %, Höchstcheckout, 100+/140+/170+/180.
  - "Referee Protected"-Turniere und eigene private Turniere nur für Plus.
- **Freunde**: Freundesliste (Suche oder letzte Gegner), Einladungen, Benachrichtigungen, Spieler blockieren.

### Im Spiel
- **Ansichten**: Live Board (Kamerabild), Virtual Board, Keyboard View.
- **Optionen**: Checkout-Hilfe anzeigen, "Count each throw", Kreidetafel (Chalkboard), Live-History.
- **Manuelle Eingabe**: über virtuelles Board oder Keypad, auch komplett ohne Hardware.
- **Korrekturen**: einzelne Darts nachträglich ändern. Die API kennt Undo, "Next Player" und "Next Game/Leg". Mit aktivem Referee ist die manuelle Eingabe gesperrt.
- **AI Referee (Plus)**:
  - Ein Spieler fordert eine Prüfung an (Roboter-Button); die KI prüft das Wurfvideo und korrigiert nur bei erkanntem Fehler.
  - Checkout-Darts werden automatisch geprüft; einen Einspruch muss der Gegner bestätigen.
  - Laut Winmau nur mit Autodarts-X-Hardware, nicht mit LENS (für DIY unklar).
- **Caller**: Standard-Sprachausgabe kostenlos; Premium-Caller Huw Ware (PDC-Referee) nur mit Plus.
  - Community: `darts-caller` (eigene Soundpakete, Checkout-Ansagen, WebSocket für Erweiterungen, Port 8079).
  - Browser-Extensions "Tools for Autodarts" (über 20k Nutzer, z. B. Auto-Start, Lobby-Erweiterungen) und "AutoDarts +".
- **Sonstiges**: Bildschirm-Spiegelung des Spiels, eigene Dart-Optik ("Custom Darts", Plus).

### Statistiken
- **X01**: 3-Dart-Average, Checkout-%, Legs gespielt/gewonnen, 60+/100+/140+/170+/180, Average bis 170, First-9-Average, Checkout-Points-Average; Zeitfenster z. B. "Last 100 Legs".
- **Cricket**: MPR, First-9-MPR, 5–9-Marks-Tabelle, White Horse.
- **Weitere Modi**: Count Up (Average, First 9, 60+ bis 180); Random Checkout (CO-%, Darts pro Checkout, Checkout-Bereiche); Bob's 27 (Trefferquote pro Doppel D1–D20 und Bull); Killer (Kills, gewonnene und verlorene Leben).
- **Match-Historie**: Filter nach Local/Online/Matchmaking/Turnier, Modus, Gegner und Zeitraum.
- **Advanced Statistics (Plus)**: Aktivität, Scoring, Checkouts, Trends über Tage, Wochen und Monate.

### Abo-Stufen (Stand Okt./Nov. 2026)
- **Free (0 €)**: manuelles Scoring, Hardware-Autoscoring (DIY/Vantage/X), 11 Spielmodi, Online-Play, Matchmaking, Turniere, Basis-Statistiken, Standard-Caller, LENS 5 Matches pro Monat.
- **Plus (5,99 £/Monat oder 59,99 £/Jahr)**: LENS unbegrenzt, Advanced Stats, Killer und 121 Checkout, Huw-Ware-Caller, eigene und private Turniere, Plus-only-Matchmaking, Custom Darts, AI Referee.
- Autodarts X behält die Kern-Autoscoring-Funktion ohne Plus.

## 5. Änderungen nach der Übernahme und Kritik

- **Neuausrichtung**:
  - Mobile-first-App (iOS/Android/Web), Fokus auf LENS (Handy) und Autodarts X statt DIY.
  - DIY-Doku als "autodarts.diy" ausgelagert; Browser-Board-Manager abgeschafft, stattdessen Desktop- und Headless-Client.
  - Accounts, Stats und Freunde wurden übernommen. Partnerschaft mit dem Amateur Darts Circuit (ADC).
- **Cloud-Zwang**: Internet ist laut offizieller FAQ Pflicht, auch für lokale Spiele. Autodarts X läuft nur mit Account. Updates können serverseitig erzwungen werden (v0.25.0 sperrte alte Clients).
- **Konnektivität**: Die App-Release-Notes (1.3.1) beheben Boards, die nach einem Netz-Reconnect auf "Starting" hängen, und ergänzen "Having trouble connecting"/Retry sowie "Stats temporarily unavailable".
- **Statusseite** (Aug.–Nov. 2026): "Sign in & Sign Up" nur 94,81 % Uptime, sonst nahezu 100 %.
- **Nutzerkritik (App-Store-Reviews)**:
  - LENS-Genauigkeit gefühlt 80–90 %; Fehler bei verdeckten Darts und nahe Triple-Feldern erfordern manuelle Korrektur.
  - Kein Referee für LENS; die App hat Hintergrund-Audio beendet (inzwischen gefixt).
  - Wünsche: Live-Video, Voice-Chat, Free-Play ohne Stats-Wirkung.
- Zu **Server-Latenz** wurden keine belastbaren öffentlichen Quellen gefunden. Reddit und Discord waren für die Recherche nicht direkt zugänglich.

## Quellen

- https://autodarts.diy/ (vormals docs.autodarts.io), daraus die Unterseiten:
  - getting-started/: hardware-requirements, cameras, camera-positioning, first-startup, distortion, installation, troubleshooting
  - how-to-play/: BoardManager, navigation-tab, in-game, lobby-settings
  - config/, Autodarts-Desktop/Setup/, Autodarts-Desktop/Overview/, Autodarts-DIY-Camera-Kit/, FAQ/, Autodarts-Plus/AI-Referee/, Autodarts-Plus/Statistics/
  - Game-Settings/: X01, cricket, bermuda, Shanghai, Gotcha, Around-the-Clock, Round-the-World, Count-Up, Random-Checkout, Segment-Training
- https://docs.autodarts.com/, daraus die Unterseiten:
  - game-modes/: x01, cricket-tactics, party/killer, practice/bobs-27
  - statistics/stats-page, multiplayer/overview, multiplayer/matchmaking, multiplayer/tournaments, getting-started/account-setup
- https://autodarts.com/
- https://status.autodarts.com/
- https://apps.apple.com/us/app/autodarts-darts-scorer/id6759263107
- https://winmau.com/blogs/news/winmau-redefines-the-future-of-darts-with-launch-of-autodarts-ecosystem
- https://winmau.com/pages/autodarts-plus-explained
- https://winmau.com/pages/autodarts-x-faqs (nur über Suchergebnis-Auszüge)
- https://www.argos.co.uk/product/9233232 (nur über Suchergebnis-Auszüge)
- https://dartsworld.com/?p=51192
- https://www.instalki.pl/news/hardware/winmau-autodarts-x-ifa-2026/
- https://notltd.co.uk/in-business/nodor-acquires-autodarts-automatic-scoring (nur über Suchergebnis-Auszüge)
- https://newreleases.io/project/github/autodarts/releases/release/v0.26.0
- https://newreleases.io/project/github/autodarts/releases/release/v0.25.0
- https://github.com/axel-h/autodarts-docs
- https://github.com/NullP0int/autodarts.io-readme
- https://github.com/lbormann/darts-caller (Quellcode darts-caller.py, broadcast-examples.dat)
- https://github.com/Peschi90/darts-caller
- https://github.com/Chade/AutodartsClient (AutodartsDefines.h)
- https://www.buffalo.nl/en/autodarts-vantage-darts-autoscoring-system (nur über Suchergebnis-Auszüge)
- https://addons.mozilla.org/firefox/addon/tools-for-autodarts (nur über Suchergebnis-Auszüge)

---

## 6. Umsetzung in Autodarter (Stand v0.1.0)

| Autodarts-Funktion | Autodarter | Anmerkung |
|---|---|---|
| 3 USB-Kameras an Pi/PC, lokaler Board-Client | ✅ | Python/OpenCV, automatische V4L2-Kameraerkennung, MJPEG, Docker |
| Lokale Board-Manager-Seite (Port 3180) | ✅ | Statusseite mit Kopplungscode, Server-Adresse, Kamerabildern |
| Board mit Konto verknüpfen (Board-ID/Claim) | ✅ | 6-stelliger Kopplungscode, Board-ID + Secret auf dem Pi |
| Kamera-Livebilder in der Web-App | ✅ | über den Server gestreamt, mit Kalibrier-Overlay |
| Manuelle 4-Punkt-Kalibrierung (20/1, 6/10, 3/19, 11/14) | ✅ | dazu ein 5. Punkt (Bull), Lupe und Pfeiltasten |
| Auto-Kalibrierung | ❌ | geplant |
| Zustände Throw / Takeout / Takeout in progress | ✅ | dazu „Hand ohne Änderung“: der Zustand bleibt erhalten |
| Start / Stopp / Reset / Kamera-Rescan | ✅ | |
| Korrektur einzelner Würfe, Undo, Next | ✅ | auch für die letzte Aufnahme nach dem Takeout |
| X01 (In/Out Straight/Double/Master, Legs) | ✅ | 301/501; Bull-off, Sets und Max-Rounds fehlen noch |
| Cricket Standard / Cut-Throat | ✅ | mit Rundenlimit; Tactics, Hidden und No-Score fehlen noch |
| Checkout-Vorschläge | ✅ | |
| Caller (Ansage) | ✅ (Web) | Web Speech API |
| Statistiken (Avg, First 9, Checkout %, MPR …) | ✅ | |
| Lobbies, Online-Spiele, Turniere, Freunde | ❌ | nur lokale Spiele (mehrere Spieler an einem Board) |
| ATC, Bermuda, Shanghai, Gotcha, Bob's 27 … | ❌ | die Engine ist event-sourced und lässt sich erweitern |
| Bounce-out-Erkennung | ❌ | geplant |
