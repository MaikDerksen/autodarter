# Autodarter board client for the Raspberry Pi 5 (arm64) – also runs on x86 for development.
FROM python:3.12-slim-bookworm

ARG AUTODARTER_VERSION=
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DATA_DIR=/data LOCAL_PORT=3180 AUTODARTER_VERSION=$AUTODARTER_VERSION

RUN apt-get update \
    && apt-get install -y --no-install-recommends libglib2.0-0 v4l-utils dbus-bin \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/autodarter
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY autodarter_board ./autodarter_board
# "autodarter" command for headless Pis:  docker exec autodarter-board autodarter code
RUN printf '#!/bin/sh\ncd /opt/autodarter && exec python -m autodarter_board.cli "$@"\n' > /usr/local/bin/autodarter \
    && chmod +x /usr/local/bin/autodarter

VOLUME ["/data"]
EXPOSE 3180
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
    CMD python -c "import urllib.request,os; urllib.request.urlopen('http://127.0.0.1:%s/api/status' % os.environ.get('LOCAL_PORT','3180'), timeout=4)" || exit 1
CMD ["python", "-m", "autodarter_board"]
