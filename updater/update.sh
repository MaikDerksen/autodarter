#!/bin/sh
# Autodarter auto-updater
#
# Runs as one more service in the same docker compose project (profile "autoupdate"), with the
# Docker socket and the project folder (mounted at /project). Regularly – or immediately when the
# app asks for it – it pulls the images of the running services and recreates exactly those
# containers whose image changed. Data lives in volumes / ./data, so nothing is lost.
#
#   UPDATE_INTERVAL   seconds between regular checks                 (default 21600 = 6 h)
#   UPDATE_HOURS      regular updates only in this local time window, e.g. "2-5"   (default: any time)
#   UPDATE_BUSY_URL   JSON endpoint; "busy": true postpones a regular update (somebody is playing)
#   UPDATE_TRIGGER    file in the project folder that requests an update now, e.g. data/update-request
#   UPDATE_HEARTBEAT  file in the project folder touched every 10 s (tells the app that auto-update is active)
#   UPDATE_EXCLUDE    services that are never updated, space separated (e.g. "db")
#   TZ                time zone for UPDATE_HOURS and the log, e.g. Europe/Berlin
set -u

INTERVAL="${UPDATE_INTERVAL:-21600}"
HOURS="${UPDATE_HOURS:-}"
BUSY_URL="${UPDATE_BUSY_URL:-}"
TRIGGER="${UPDATE_TRIGGER:-}"
HEARTBEAT="${UPDATE_HEARTBEAT:-}"
EXCLUDE="${UPDATE_EXCLUDE:-}"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# --- who am I? (works with bridge and host network: /etc/hostname is mounted from the container dir)
SELF=$(grep -o 'containers/[0-9a-f]\{64\}' /proc/self/mountinfo | head -n 1 | cut -d/ -f2)
[ -n "$SELF" ] || SELF=$(hostname)
label() { docker inspect -f "{{ index .Config.Labels \"$1\" }}" "$SELF" 2>/dev/null; }
PROJECT=$(label com.docker.compose.project)
WORKDIR=$(label com.docker.compose.project.working_dir)
SELF_SERVICE=$(label com.docker.compose.service)
CONFIG_FILES=$(label com.docker.compose.project.config_files)
if [ -z "$PROJECT" ] || [ -z "$WORKDIR" ]; then
  log "FEHLER: eigenes Compose-Projekt nicht gefunden – läuft der Updater über docker compose mit /var/run/docker.sock?"
  exit 1
fi

# --- make the project folder reachable under its host path, so that relative bind mounts (./data,
#     ./deploy/Caddyfile) and .env resolve exactly as on the host
if [ "$WORKDIR" != /project ]; then
  if [ -e "$WORKDIR" ] && [ ! -L "$WORKDIR" ]; then
    log "FEHLER: $WORKDIR existiert im Updater-Container – Projektordner bitte woanders ablegen"
    exit 1
  fi
  mkdir -p "$(dirname "$WORKDIR")"
  ln -sfn /project "$WORKDIR"
fi
cd "$WORKDIR" || exit 1
FILE_ARGS=""
for f in $(echo "$CONFIG_FILES" | tr ',' ' '); do FILE_ARGS="$FILE_ARGS -f $f"; done

compose() {
  # shellcheck disable=SC2086
  docker compose -p "$PROJECT" $FILE_ARGS "$@"
}

excluded() {
  [ "$1" = "$SELF_SERVICE" ] && return 0
  for e in $EXCLUDE; do [ "$1" = "$e" ] && return 0; done
  return 1
}

in_window() {
  [ -n "$HOURS" ] || return 0
  h=$(date +%H | sed 's/^0//'); from=${HOURS%-*}; to=${HOURS#*-}
  if [ "$from" -le "$to" ]; then [ "$h" -ge "$from" ] && [ "$h" -lt "$to" ]
  else [ "$h" -ge "$from" ] || [ "$h" -lt "$to" ]; fi
}

is_busy() {
  [ -n "$BUSY_URL" ] || return 1
  wget -qO- -T 5 "$BUSY_URL" 2>/dev/null | grep -Eq '"busy": ?true'
}

# "Server aktualisieren" in the app: the server answers "update": true once
REQUEST_URL=""
if [ -n "$BUSY_URL" ]; then
  case "$BUSY_URL" in *\?*) REQUEST_URL="$BUSY_URL&updater=1" ;; *) REQUEST_URL="$BUSY_URL?updater=1" ;; esac
fi
requested() {
  [ -n "$REQUEST_URL" ] || return 1
  wget -qO- -T 5 "$REQUEST_URL" 2>/dev/null | grep -Eq '"update": ?true'
}

# The updater cannot recreate its own container while it runs in it: a short-lived helper container
# (same image) does it a few seconds later.
self_update() {
  ref=$(docker inspect -f '{{ .Config.Image }}' "$SELF" 2>/dev/null) || return 0
  case "$ref" in localhost/*|"") return 0 ;; esac
  docker pull -q "$ref" >/dev/null 2>&1 || return 0
  running=$(docker inspect -f '{{ .Image }}' "$SELF")
  latest=$(docker image inspect -f '{{ .Id }}' "$ref" 2>/dev/null || true)
  [ -n "$latest" ] && [ "$latest" != "$running" ] || return 0
  log "Neue Version des Updaters – er wird in ein paar Sekunden neu gestartet"
  # shellcheck disable=SC2086
  docker run -d --rm --entrypoint sh -v /var/run/docker.sock:/var/run/docker.sock -v "$WORKDIR:$WORKDIR" -w "$WORKDIR" "$ref"     -c "sleep 5; docker compose -p '$PROJECT' $FILE_ARGS up -d --no-deps --no-build '$SELF_SERVICE'" >/dev/null 2>&1     || log "  Neustart des Updaters fehlgeschlagen"
}

update() {
  log "Suche nach Updates ($1) …"
  # 1) pull the image of every running service (once per image)
  refs=""
  for c in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
    svc=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$c")
    excluded "$svc" && continue
    ref=$(docker inspect -f '{{ .Config.Image }}' "$c")
    case " $refs " in *" $ref "*) continue ;; esac
    refs="$refs $ref"
    case "$ref" in
      localhost/*) continue ;;  # built locally, not from a registry
    esac
    docker pull -q "$ref" >/dev/null 2>&1 || log "  $ref: Pull fehlgeschlagen (Registry erreichbar? Login nötig?)"
  done
  # 2) recreate only the services whose image changed
  changed=""
  for c in $(docker ps -q --filter "label=com.docker.compose.project=$PROJECT"); do
    svc=$(docker inspect -f '{{ index .Config.Labels "com.docker.compose.service" }}' "$c")
    excluded "$svc" && continue
    ref=$(docker inspect -f '{{ .Config.Image }}' "$c")
    running=$(docker inspect -f '{{ .Image }}' "$c")
    latest=$(docker image inspect -f '{{ .Id }}' "$ref" 2>/dev/null || true)
    if [ -n "$latest" ] && [ "$latest" != "$running" ]; then
      case " $changed " in *" $svc "*) ;; *) changed="$changed $svc" ;; esac
    fi
  done
  if [ -z "$changed" ]; then
    log "Alles aktuell."
    self_update
    return 0
  fi
  log "Neue Version für:$changed – Container werden neu erstellt"
  # shellcheck disable=SC2086
  if compose up -d --no-deps --no-build $changed; then
    log "Update fertig."
    docker image prune -f >/dev/null 2>&1 || true
    self_update
  else
    log "FEHLER beim Neustart der Container"
  fi
}

log "Autodarter Auto-Update für Projekt \"$PROJECT\" ($WORKDIR): alle ${INTERVAL}s${HOURS:+, nur zwischen $HOURS Uhr}${BUSY_URL:+, nicht während gespielt wird}"
next=$(( $(date +%s) + ${UPDATE_FIRST_DELAY:-120} ))
while true; do
  [ -n "$HEARTBEAT" ] && touch "/project/$HEARTBEAT" 2>/dev/null
  now=$(date +%s)
  if [ -n "$TRIGGER" ] && [ -f "/project/$TRIGGER" ]; then
    rm -f "/project/$TRIGGER"
    update "in der App angefordert"
    next=$(( now + INTERVAL ))
  elif requested; then
    update "in der App angefordert"
    next=$(( now + INTERVAL ))
  elif [ "$now" -ge "$next" ]; then
    if ! in_window; then
      next=$(( now + 300 ))
    elif is_busy; then
      log "Es wird gerade gespielt – Update in 10 Minuten erneut versuchen"
      next=$(( now + 600 ))
    else
      update "regelmäßig"
      next=$(( now + INTERVAL ))
    fi
  fi
  sleep 10
done
