# Autodarter auto-updater: docker CLI + compose plugin + a small update loop (see update.sh).
FROM docker:28-cli
RUN apk add --no-cache tzdata
COPY update.sh /usr/local/bin/autodarter-update
RUN chmod +x /usr/local/bin/autodarter-update
ENTRYPOINT ["/usr/local/bin/autodarter-update"]
