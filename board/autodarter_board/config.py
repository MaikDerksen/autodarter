"""Configuration from environment + persistent state in DATA_DIR."""
from __future__ import annotations

import json
import os
import secrets
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from threading import Lock

DATA_DIR = Path(os.environ.get("DATA_DIR", "./data"))
LOCAL_PORT = int(os.environ.get("LOCAL_PORT", "3180"))
CAMERA_SOURCE = os.environ.get("CAMERA_SOURCE", "v4l2").lower()  # v4l2 | sim
CAMERAS = [c.strip() for c in os.environ.get("CAMERAS", "").split(",") if c.strip()]
SIM_AUTOCALIBRATE = os.environ.get("SIM_AUTOCALIBRATE", "1") != "0"
LOG_LEVEL = os.environ.get("LOG_LEVEL", "INFO").upper()
# Allow rebooting the Raspberry Pi from the web app (needs the host D-Bus socket mounted)
ALLOW_REBOOT = os.environ.get("ALLOW_REBOOT", "false").lower() in ("1", "true", "yes")
DBUS_SOCKET = os.environ.get("DBUS_SOCKET", "/run/dbus/system_bus_socket")
# Auto-update: the updater container (profile "autoupdate") touches HEARTBEAT regularly and
# runs an update as soon as UPDATE_REQUEST exists (both inside the shared ./data folder).
UPDATER_HEARTBEAT = DATA_DIR / ".autoupdate-heartbeat"
UPDATE_REQUEST = DATA_DIR / "update-request"
# Version of the image (set by CI), falls back to the package version.
BUILD_VERSION = os.environ.get("AUTODARTER_VERSION", "")


@dataclass
class Settings:
    resolution: list[int] = field(default_factory=lambda: [1280, 720])
    fps: int = 15
    diffThreshold: int = 28
    minDartArea: int = 40
    takeoutArea: int = 6000
    settleFrames: int = 3

    def update(self, data: dict) -> None:
        for key, value in data.items():
            if not hasattr(self, key):
                continue
            if key == "resolution":
                if isinstance(value, (list, tuple)) and len(value) == 2:
                    self.resolution = [int(value[0]), int(value[1])]
            else:
                setattr(self, key, int(value))

    def to_dict(self) -> dict:
        return asdict(self)


class Store:
    """Small JSON store for identity, calibration, settings and local options."""

    def __init__(self, data_dir: Path = DATA_DIR):
        self.dir = data_dir
        self.dir.mkdir(parents=True, exist_ok=True)
        self._lock = Lock()
        self.identity = self._load("identity.json", None)
        if not self.identity:
            self.identity = {"boardId": str(uuid.uuid4()), "secret": secrets.token_hex(32)}
            self._save("identity.json", self.identity)
        # calibration keyed by stable camera id
        self.calibration: dict[str, dict] = self._load("calibration.json", {})
        self.settings = Settings()
        self.settings.update(self._load("settings.json", {}))
        self.local: dict = self._load("local.json", {})

    def _load(self, name: str, default):
        path = self.dir / name
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return default
        except Exception:  # corrupt file -> keep a backup and start fresh
            path.rename(path.with_suffix(".broken"))
            return default

    def _save(self, name: str, data) -> None:
        with self._lock:
            tmp = self.dir / (name + ".tmp")
            tmp.write_text(json.dumps(data, indent=2), encoding="utf-8")
            tmp.replace(self.dir / name)

    @property
    def board_id(self) -> str:
        return self.identity["boardId"]

    @property
    def secret(self) -> str:
        return self.identity["secret"]

    @property
    def server_url(self) -> str:
        return self.local.get("server") or os.environ.get("AUTODARTER_SERVER", "")

    def set_server_url(self, url: str) -> None:
        self.local["server"] = url.strip().rstrip("/")
        self._save("local.json", self.local)

    def save_calibration(self) -> None:
        self._save("calibration.json", self.calibration)

    def save_settings(self) -> None:
        self._save("settings.json", self.settings.to_dict())
