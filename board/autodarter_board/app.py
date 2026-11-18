"""Board client: wires cameras, detector, server connection and the local status page together."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
import threading
import time
from collections import deque

import aiohttp
import cv2

from . import __version__
from .cameras import CameraManager
from .config import (
    ALLOW_REBOOT,
    BUILD_VERSION,
    CAMERA_SOURCE,
    CAMERAS,
    DBUS_SOCKET,
    SIM_AUTOCALIBRATE,
    UPDATE_REQUEST,
    UPDATER_HEARTBEAT,
    Store,
)
from .detector import Detector
from .geometry import board_to_image_homography, front_view, segment_label

log = logging.getLogger("autodarter")

# Darts / takeouts that happen while the internet connection is down are delivered
# after the reconnect, as long as they are not older than this.
OUTBOX_MAX_AGE = 180
# Somebody threw / pulled darts within this time -> "busy" (the auto-updater waits).
BUSY_SECONDS = 15 * 60
# Edge length (px) of the frontal camera view.
FRONT_SIZE = 520


def encode_jpeg(frame, max_width: int | None = None, quality: int = 75) -> tuple[str, int, int]:
    h, w = frame.shape[:2]
    if max_width and w > max_width:
        frame = cv2.resize(frame, (max_width, int(h * max_width / w)), interpolation=cv2.INTER_AREA)
        h, w = frame.shape[:2]
    ok, buf = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("jpeg encoding failed")
    return base64.b64encode(buf.tobytes()).decode("ascii"), w, h


class BoardApp:
    def __init__(self) -> None:
        self.store = Store()
        self.sim = None
        if CAMERA_SOURCE == "sim":
            from .sim import SimWorld

            w, h = self.store.settings.resolution
            self.sim = SimWorld(cameras=3, width=w, height=h)
        self.cameras = CameraManager(CAMERA_SOURCE, CAMERAS, self.sim)
        self.detector = Detector(self.store.settings)
        self.loop: asyncio.AbstractEventLoop | None = None
        self.queue: asyncio.Queue | None = None
        self.ws: aiohttp.ClientWebSocketResponse | None = None
        self.connected = False
        self.claimed = False
        self.pairing_code: str | None = None
        self.board_name: str | None = None
        self.server_error: str | None = None
        self.stream = {"enabled": False, "fps": 4, "maxWidth": 640, "raw": False, "front": []}
        self._front_h: dict[int, tuple[tuple, object]] = {}
        self.last_activity = 0.0
        self._code_logged = 0.0
        self.last_dart: dict | None = None
        self.proc_fps = 0.0
        self.running = True
        self._reconnect = asyncio.Event()
        self._status_sig = None
        self._cam_lock = threading.Lock()
        self.outbox: deque[tuple[float, dict]] = deque(maxlen=200)
        self.notice: str | None = None

    # ------------------------------------------------------------------ cameras & calibration
    def start_cameras(self) -> None:
        with self._cam_lock:
            w, h = self.store.settings.resolution
            self.cameras.start(w, h, self.store.settings.fps)
            if self.sim is not None and SIM_AUTOCALIBRATE:
                for s in self.cameras.streams:
                    self.store.calibration.setdefault(s.cam_id, {"points": [list(p) for p in self.sim.calibration(s.index)]})
            self.apply_calibration()
            self.detector.reset()

    def apply_calibration(self) -> None:
        self.resolve_calibration()
        for idx in list(self.detector.cams):
            self.detector.set_calibration(idx, None)
        for s in self.cameras.streams:
            cal = self.store.calibration.get(s.cam_id)
            if cal and len(cal.get("points", [])) == 5:
                self.detector.set_calibration(s.index, [tuple(p) for p in cal["points"]])

    def resolve_calibration(self) -> None:
        """Find the saved calibration of every camera, even if its id changed.

        Calibrations are never thrown away (darkness, unplugged camera, restart): they stay in
        data/calibration.json until somebody recalibrates or resets that camera.
        """
        store = self.store.calibration
        changed = False
        used = {s.cam_id for s in self.cameras.streams}
        missing = []
        for s in self.cameras.streams:
            if s.cam_id in store:
                entry = store[s.cam_id]
                if entry.get("index") != s.index or entry.get("device") != getattr(s, "device", None):
                    entry["index"], entry["device"] = s.index, getattr(s, "device", None)
                    changed = True
                continue
            alias = next((a for a in getattr(s, "aliases", ()) if a in store and a not in used), None)
            if alias:
                # same camera, older id format (udev link / device name) -> move it to the stable id
                store[s.cam_id] = {**store.pop(alias), "index": s.index, "device": getattr(s, "device", None)}
                used.add(alias)
                log.info("Kalibrierung von Kamera %d übernommen (%s -> %s)", s.index + 1, alias, s.cam_id)
                changed = True
            else:
                missing.append(s)
        orphans = {k: v for k, v in store.items() if k not in used and not k.startswith("sim-")}
        if missing and orphans and len(store) == len(self.cameras.streams):
            # every camera is there, but some ids are new: take the calibration saved for the same camera number
            for s in missing:
                key = next((k for k, v in orphans.items() if v.get("index") == s.index), None)
                if key is None:
                    continue
                store[s.cam_id] = {**store.pop(key), "index": s.index, "device": getattr(s, "device", None)}
                orphans.pop(key)
                log.warning("Kamera %d hat eine neue Kennung (%s -> %s) – gespeicherte Kalibrierung übernommen", s.index + 1, key, s.cam_id)
                changed = True
        for s in self.cameras.streams:
            if s.cam_id not in store and orphans:
                log.warning("Kamera %d (%s) hat keine Kalibrierung – gespeichert sind: %s", s.index + 1, s.cam_id, ", ".join(orphans))
        if changed:
            self.store.save_calibration()

    def restore_calibration(self, backup: dict) -> bool:
        """Calibrations the server kept as backup (keyed by camera id) – used when the Pi lost its own."""
        restored = False
        for s in self.cameras.streams:
            if s.cam_id in self.store.calibration:
                continue
            for key in (s.cam_id, *getattr(s, "aliases", ())):
                cal = backup.get(key)
                points = cal.get("points") if isinstance(cal, dict) else None
                if points and len(points) == 5:
                    self.store.calibration[s.cam_id] = {
                        "points": [[float(p["x"]), float(p["y"])] if isinstance(p, dict) else [float(p[0]), float(p[1])] for p in points],
                        "index": s.index,
                        "device": getattr(s, "device", None),
                    }
                    log.warning("Kalibrierung von Kamera %d vom Server wiederhergestellt", s.index + 1)
                    restored = True
                    break
        if restored:
            self.store.save_calibration()
            self.apply_calibration()
            self.detector.reset()
        return restored

    def calibration_by_index(self) -> dict:
        out = {}
        for s in self.cameras.streams:
            cal = self.store.calibration.get(s.cam_id)
            out[str(s.index)] = {"points": [{"x": p[0], "y": p[1]} for p in cal["points"]], "camId": s.cam_id} if cal else None
        return out

    def status(self) -> dict:
        cams = []
        for s in self.cameras.streams:
            cams.append(
                {
                    "index": s.index,
                    "id": s.cam_id,
                    "name": s.name,
                    "device": s.device,
                    "width": s.width,
                    "height": s.height,
                    "fps": round(s.measured_fps, 1),
                    "ok": bool(s.ok),
                    "calibrated": s.index in self.detector.cams,
                }
            )
        state = self.detector.public_state()
        message = None
        if not cams:
            state, message = "error", "Keine USB-Kameras gefunden."
        elif not any(c["ok"] for c in cams):
            state, message = "starting", "Warte auf Kamerabilder …"
        elif state == "calibration_needed":
            message = "Bitte mindestens eine Kamera kalibrieren."
        elif not all(c["calibrated"] for c in cams):
            message = "Nicht alle Kameras sind kalibriert – die Genauigkeit ist reduziert."
        if self.detector.dark:
            message = (message + " " if message else "") + "Zu dunkel – die Erkennung wartet auf Licht (Kalibrierung bleibt gespeichert)."
        if self.sim is not None:
            message = (message + " " if message else "") + "Simulationsmodus."
        if self.notice:
            message = (message + " " if message else "") + self.notice
        return {
            "state": state,
            "detecting": self.detector.detecting,
            "darts": self.detector.darts,
            "fps": round(self.proc_fps, 1),
            "cameras": cams,
            "message": message,
            "version": BUILD_VERSION or __version__,
            "capabilities": {"restart": True, "reboot": self.can_reboot(), "update": self.can_update(), "autoCalibrate": True},
        }

    def auto_calibrate(self, index: int, prior, hint20) -> dict:
        """Find the board in the current image of a camera. Only a proposal: the app shows it and saves it."""

        def fail(message: str) -> dict:
            return {"ok": False, "points": None, "score": 0.0, "mode": "full", "needsHint": False, "message": message}

        cam = self.cameras.by_index(index)
        if cam is None:
            return fail("Kamera nicht gefunden")
        _, frame = cam.latest()
        if frame is None:
            return fail("Die Kamera liefert gerade kein Bild")
        try:
            from .autocal import auto_calibrate

            pts = [(float(p["x"]), float(p["y"])) for p in prior] if isinstance(prior, list) and len(prior) == 5 else None
            hint = (float(hint20["x"]), float(hint20["y"])) if isinstance(hint20, dict) else None
            started = time.time()
            res = auto_calibrate(frame, prior=pts, hint20=hint)
        except Exception as exc:  # never take the board client down
            log.exception("auto calibration of camera %s failed", index + 1)
            return fail(f"Automatische Erkennung fehlgeschlagen: {exc}")
        out = res.get("points")
        log.info(
            "Auto-Kalibrierung Kamera %s: ok=%s score=%.2f mode=%s (%.1f s)",
            index + 1, res.get("ok"), float(res.get("score") or 0), res.get("mode"), time.time() - started,
        )
        return {
            "ok": bool(res.get("ok")),
            "points": [{"x": float(x), "y": float(y)} for x, y in out] if out else None,
            "score": round(float(res.get("score") or 0), 3),
            "mode": "refine" if res.get("mode") == "refine" else "full",
            "needsHint": bool(res.get("needsHint")),
            "message": str(res.get("message") or ""),
        }

    def can_reboot(self) -> bool:
        return ALLOW_REBOOT and os.path.exists(DBUS_SOCKET)

    def can_update(self) -> bool:
        """The auto-update container is running (it touches its heartbeat file every few seconds)."""
        try:
            return time.time() - UPDATER_HEARTBEAT.stat().st_mtime < 120
        except OSError:
            return False

    @property
    def busy(self) -> bool:
        return time.time() - self.last_activity < BUSY_SECONDS

    # ------------------------------------------------------------------ detection thread
    def detection_thread(self) -> None:
        count, last = 0, time.time()
        while self.running:
            start = time.time()
            try:
                with self._cam_lock:
                    frames = self.cameras.frames()
                events = self.detector.process(frames) if frames else []
            except Exception:  # never let the loop die
                log.exception("detection step failed")
                events = []
            for ev in events:
                if self.loop and self.queue:
                    self.loop.call_soon_threadsafe(self.queue.put_nowait, ev)
            count += 1
            if time.time() - last >= 2:
                self.proc_fps = count / (time.time() - last)
                count, last = 0, time.time()
            period = 1.0 / max(1, self.store.settings.fps)
            time.sleep(max(0.0, period - (time.time() - start)))

    # ------------------------------------------------------------------ server connection
    async def send(self, msg: dict) -> bool:
        ws = self.ws
        if ws is None or ws.closed or not self.connected:
            return False
        try:
            await ws.send_str(json.dumps(msg))
            return True
        except Exception as err:  # connection dropped
            log.debug("send failed: %s", err)
            return False

    async def send_event(self, msg: dict) -> None:
        """Darts and takeouts must not get lost when the internet connection hiccups."""
        if self.outbox or not await self.send(msg):
            self.outbox.append((time.time(), msg))
            if not self.connected:
                log.warning("offline – %s buffered (%d waiting)", msg["type"], len(self.outbox))
            await self.flush_outbox()

    async def flush_outbox(self) -> None:
        while self.outbox and self.connected:
            at, msg = self.outbox[0]
            if time.time() - at > OUTBOX_MAX_AGE:
                self.outbox.popleft()
                log.warning("dropping stale %s from %.0fs ago", msg["type"], time.time() - at)
                continue
            if not await self.send(msg):
                return
            self.outbox.popleft()

    async def send_status(self, force: bool = False) -> None:
        st = self.status()
        sig = json.dumps({k: v for k, v in st.items() if k != "fps"} | {"cams": [(c["ok"], c["calibrated"]) for c in st["cameras"]]}, default=str)
        if force or sig != self._status_sig:
            self._status_sig = sig
            await self.send({"type": "status", "status": st})

    def ws_url(self) -> str | None:
        url = self.store.server_url
        if not url:
            return None
        if url.startswith("http"):
            url = "ws" + url[4:]
        elif not url.startswith("ws"):
            # no scheme: a domain name means "over the internet" -> encrypted; IP / explicit port -> LAN
            host = url.split("/")[0]
            is_lan = ":" in host or host.replace(".", "").isdigit() or host == "localhost"
            url = ("ws://" if is_lan else "wss://") + url
        return url.rstrip("/") + "/ws/board"

    async def server_loop(self) -> None:
        backoff = 1
        # trust_env: honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY (company networks)
        async with aiohttp.ClientSession(trust_env=True) as session:
            while self.running:
                url = self.ws_url()
                if not url:
                    self.server_error = "Keine Server-Adresse konfiguriert (AUTODARTER_SERVER oder Statusseite)."
                    await self._wait_reconnect(5)
                    continue
                try:
                    async with session.ws_connect(url, heartbeat=20, max_msg_size=32 * 1024 * 1024) as ws:
                        self.ws = ws
                        self.server_error = None
                        backoff = 1
                        log.info("connected to %s", url)
                        await ws.send_str(
                            json.dumps(
                                {
                                    "type": "hello",
                                    "boardId": self.store.board_id,
                                    "secret": self.store.secret,
                                    "version": __version__,
                                    "status": self.status(),
                                    "calibration": self.calibration_by_index(),
                                    "settings": self.store.settings.to_dict(),
                                }
                            )
                        )
                        self.connected = True  # only after the hello, so nothing overtakes it
                        if self.outbox:
                            log.info("delivering %d buffered events", len(self.outbox))
                            await self.flush_outbox()
                        reconnect_task = asyncio.create_task(self._reconnect.wait())
                        try:
                            async for msg in ws:
                                if msg.type == aiohttp.WSMsgType.TEXT:
                                    try:
                                        await self.handle(json.loads(msg.data))
                                    except Exception:
                                        log.exception("failed to handle server message")
                                elif msg.type in (aiohttp.WSMsgType.ERROR, aiohttp.WSMsgType.CLOSE):
                                    break
                                if reconnect_task.done():
                                    break
                        finally:
                            reconnect_task.cancel()
                        if ws.close_code and ws.close_code >= 4000:
                            self.server_error = f"Server hat die Verbindung abgelehnt ({ws.close_code})"
                except Exception as err:
                    self.server_error = f"Server nicht erreichbar: {err}"
                    log.warning("server connection failed: %s", err)
                finally:
                    self.ws = None
                    self.connected = False
                    self.stream["enabled"] = False
                await self._wait_reconnect(backoff)
                backoff = min(backoff * 2, 30)

    async def _wait_reconnect(self, seconds: float) -> None:
        try:
            await asyncio.wait_for(self._reconnect.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass
        self._reconnect.clear()

    def request_reconnect(self) -> None:
        self._reconnect.set()
        if self.ws is not None and not self.ws.closed and self.loop is not None:
            self.loop.create_task(self.ws.close())

    async def handle(self, msg: dict) -> None:
        t = msg.get("type")
        if t == "welcome":
            self.claimed = bool(msg.get("claimed"))
            self.pairing_code = msg.get("pairingCode")
            self.board_name = msg.get("name")
            self.log_pairing_code()
            backup = msg.get("calibrationBackup")
            if isinstance(backup, dict) and backup and await asyncio.to_thread(self.restore_calibration, backup):
                await self.send({"type": "calibration", "calibration": self.calibration_by_index()})
            await self.send_status(force=True)
        elif t == "stream":
            self.stream = {
                "enabled": bool(msg.get("enabled")),
                "fps": float(msg.get("fps", 4)),
                "maxWidth": int(msg.get("maxWidth", 640)),
                # older servers only know "enabled" = raw camera images
                "raw": bool(msg.get("raw", msg.get("enabled"))),
                "front": [int(i) for i in msg.get("front", []) if isinstance(i, int)],
            }
        elif t == "snapshot_request":
            cam = self.cameras.by_index(int(msg.get("camera", 0)))
            data, w, h = None, 0, 0
            if cam is not None:
                _, frame = cam.latest()
                if frame is not None:
                    data, w, h = await asyncio.to_thread(encode_jpeg, frame, None, 90)
            await self.send({"type": "snapshot", "requestId": msg.get("requestId"), "camera": int(msg.get("camera", 0)), "data": data, "width": w, "height": h})
        elif t == "auto_calibrate":
            index = int(msg.get("camera", 0))
            result = await asyncio.to_thread(self.auto_calibrate, index, msg.get("prior"), msg.get("hint20"))
            await self.send({"type": "auto_calibration", "requestId": msg.get("requestId"), "camera": index, "result": result})
        elif t == "set_calibration":
            cam = self.cameras.by_index(int(msg.get("camera", -1)))
            if cam is None:
                return
            cal = msg.get("calibration")
            if cal and len(cal.get("points", [])) == 5:
                self.store.calibration[cam.cam_id] = {
                    "points": [[float(p["x"]), float(p["y"])] for p in cal["points"]],
                    "index": cam.index,
                    "device": getattr(cam, "device", None),
                    "saved": time.time(),
                }
                log.info("Kalibrierung von Kamera %d gespeichert (%s)", cam.index + 1, cam.cam_id)
            else:
                self.store.calibration.pop(cam.cam_id, None)
            self.store.save_calibration()
            self.apply_calibration()
            self.detector.reset()
            await self.send({"type": "calibration", "calibration": self.calibration_by_index()})
            await self.send_status(force=True)
        elif t == "command":
            await self.command(msg.get("action", ""))
        elif t == "set_settings":
            old = (list(self.store.settings.resolution), self.store.settings.fps)
            self.store.settings.update(msg.get("settings") or {})
            self.store.save_settings()
            if old != (list(self.store.settings.resolution), self.store.settings.fps):
                await asyncio.to_thread(self.start_cameras)
            await self.send({"type": "settings", "settings": self.store.settings.to_dict()})
            await self.send_status(force=True)
        elif t == "ping":
            await self.send({"type": "pong"})
        elif t == "error":
            self.server_error = msg.get("message")
            log.error("server error: %s", self.server_error)

    def log_pairing_code(self) -> None:
        """Pairing code as an eye-catching block in the log (headless Pi: docker compose logs board)."""
        self._code_logged = time.time()
        if self.claimed:
            log.info("Board ist mit einem Konto verbunden (%s) – Code für weitere Spieler: %s", self.board_name, self.pairing_code)
        elif self.pairing_code:
            line = "=" * 52
            log.info(
                "\n%s\n   KOPPLUNGSCODE:  %s\n   In der App: Boards → Board hinzufügen\n   (jederzeit: docker exec autodarter-board autodarter code)\n%s",
                line, self.pairing_code, line,
            )

    async def command(self, action: str) -> None:
        if action == "start":
            self.detector.set_detecting(True)
        elif action == "stop":
            self.detector.set_detecting(False)
        elif action == "reset":
            self.detector.reset()
        elif action == "rescan":
            await asyncio.to_thread(self.start_cameras)
            await self.send({"type": "calibration", "calibration": self.calibration_by_index()})
        elif action == "restart":
            await self.restart_client()
            return
        elif action == "reboot":
            await self.reboot_host()
        elif action == "update":
            self.request_update()
        await self.send_status(force=True)

    def request_update(self) -> None:
        """Ask the auto-update container to pull the newest images now (it restarts this client)."""
        if not self.can_update():
            self.notice = "Auto-Update ist nicht aktiv (COMPOSE_PROFILES=autoupdate in board/.env)."
            return
        UPDATE_REQUEST.write_text(str(time.time()))
        self.notice = "Update angefordert – der Board-Client startet gleich neu, falls es eine neue Version gibt."
        log.warning("update requested")

    async def restart_client(self) -> None:
        """Exit the process – Docker (restart: unless-stopped) starts it again within seconds."""
        log.warning("restart requested – exiting, the container restarts automatically")
        self.notice = "Board-Client startet neu …"
        await self.send_status(force=True)
        self.running = False
        await asyncio.to_thread(self.cameras.stop)
        if self.ws is not None and not self.ws.closed:
            await self.ws.close()
        os._exit(3)

    async def reboot_host(self) -> None:
        """Reboot the Raspberry Pi via systemd-logind on the host D-Bus (needs ALLOW_REBOOT=true)."""
        if not self.can_reboot():
            self.notice = "Pi-Neustart ist nicht freigegeben (ALLOW_REBOOT=true und D-Bus-Socket nötig)."
            return
        log.warning("reboot of the host requested")
        self.notice = "Raspberry Pi startet neu …"
        await self.send_status(force=True)
        proc = await asyncio.create_subprocess_exec(
            "dbus-send", "--system", "--print-reply", "--dest=org.freedesktop.login1",
            "/org/freedesktop/login1", "org.freedesktop.login1.Manager.Reboot", "boolean:false",
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            env={**os.environ, "DBUS_SYSTEM_BUS_ADDRESS": f"unix:path={DBUS_SOCKET}"},
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            self.notice = "Pi-Neustart fehlgeschlagen: " + err.decode(errors="replace").strip()[:200]
            log.error(self.notice)

    # ------------------------------------------------------------------ async workers
    async def event_worker(self) -> None:
        assert self.queue is not None
        while self.running:
            ev = await self.queue.get()
            kind = ev[0]
            self.last_activity = time.time()
            if kind == "dart":
                dart = ev[1]
                self.last_dart = {**dart, "label": segment_label(dart["seg"]["number"], dart["seg"]["multiplier"]), "at": time.time()}
                log.info("dart %s at (%.1f, %.1f) cams=%s conf=%.2f", self.last_dart["label"], dart["x"], dart["y"], dart["cameras"], dart["confidence"])
                await self.send_event({"type": "dart", "dart": dart})
            elif kind in ("takeout_started", "takeout_finished"):
                log.info(kind)
                await self.send_event({"type": kind})
            await self.send_status()

    def _front_homography(self, s, w: int, h: int):
        """Board->image homography of a camera at the given frame size (cached)."""
        cal = self.store.calibration.get(s.cam_id)
        if not cal or len(cal.get("points", [])) != 5:
            return None
        key = (w, h, tuple(tuple(p) for p in cal["points"]))
        cached = self._front_h.get(s.index)
        if cached is None or cached[0] != key:
            cached = (key, board_to_image_homography([tuple(p) for p in cal["points"]], w, h))
            self._front_h[s.index] = cached
        return cached[1]

    def encode_front(self, s, frame, size: int):
        h, w = frame.shape[:2]
        H = self._front_homography(s, w, h)
        if H is None:
            return None
        return encode_jpeg(front_view(frame, H, size), None, 72)

    async def stream_worker(self) -> None:
        while self.running:
            st = self.stream
            if st["enabled"] and self.connected:
                start = time.time()
                for s in list(self.cameras.streams):
                    _, frame = s.latest()
                    if frame is None:
                        continue
                    if st["raw"]:
                        data, w, h = await asyncio.to_thread(encode_jpeg, frame, st["maxWidth"], 70)
                        await self.send({"type": "frame", "camera": s.index, "data": data, "width": w, "height": h, "view": "raw"})
                    if s.index in st["front"]:
                        res = await asyncio.to_thread(self.encode_front, s, frame, min(FRONT_SIZE, st["maxWidth"]))
                        if res is not None:
                            data, w, h = res
                            await self.send({"type": "frame", "camera": s.index, "data": data, "width": w, "height": h, "view": "front"})
                await asyncio.sleep(max(0.05, 1 / max(0.5, st["fps"]) - (time.time() - start)))
            else:
                await asyncio.sleep(0.3)

    async def status_worker(self) -> None:
        while self.running:
            await asyncio.sleep(1)
            now = time.time()
            # repeat the code every few minutes while the board is not in an account yet
            if not self.claimed and self.pairing_code and now - self._code_logged > 300:
                self.log_pairing_code()
            if not self.store.server_url and now - self._code_logged > 60:
                self._code_logged = now
                log.warning("Keine Server-Adresse gesetzt: AUTODARTER_SERVER in .env oder  docker exec autodarter-board autodarter server https://…")
            await self.send_status()
            if int(time.time()) % 10 == 0:
                await self.send_status(force=True)  # keeps fps up to date

    async def run(self) -> None:
        from .webui import start_webui

        self.loop = asyncio.get_running_loop()
        self.queue = asyncio.Queue(maxsize=1000)
        log.info("Autodarter board %s (id %s), camera source: %s", __version__, self.store.board_id, CAMERA_SOURCE)
        await asyncio.to_thread(self.start_cameras)
        threading.Thread(target=self.detection_thread, daemon=True, name="detector").start()
        runner = await start_webui(self)
        try:
            await asyncio.gather(self.server_loop(), self.event_worker(), self.stream_worker(), self.status_worker())
        finally:
            self.running = False
            await runner.cleanup()
            self.cameras.stop()
