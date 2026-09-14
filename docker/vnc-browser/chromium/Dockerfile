# OmniRoute persistent VNC login browser.
#
# Extends linuxserver/chromium, which ships Chromium + a noVNC-style web UI on
# port 3000 (Selkies) and a persistent profile dir at /config. We add:
#   - CHROME_CLI flags so the *visible* browser also opens a DevTools port, and
#   - a small in-container TCP bridge (cdp-bridge.py) that republishes
#     Chromium's loopback CDP (127.0.0.1:9222) onto 0.0.0.0:9223, because
#     Chrome 150 ignores --remote-debugging-address and binds loopback only.
#     The OmniRoute server harvests cookies over the host-mapped 9223.
#
# Alpine/Debian package mirrors are unreachable from the build sandbox, so we
# extend a prebuilt image rather than apt/apk-installing anything.
#
# SC-8: base image pinned by tag AND digest (multi-arch index, resolved 2026-09-14).
# The upstream tag is the moving `latest`; the digest freezes the image that tag
# pointed at. Bump the digest deliberately; a tag alone can be re-pointed upstream.
FROM linuxserver/chromium:latest@sha256:54a61718733c82ac041e7c84543283419b06ab0d6439eef5c20b1f6a53b8dcd0

COPY cdp-bridge.py /usr/local/bin/cdp-bridge.py
COPY svc-de-run /etc/s6-overlay/s6-rc.d/svc-de/run
RUN chmod +x /usr/local/bin/cdp-bridge.py /etc/s6-overlay/s6-rc.d/svc-de/run

# 3000 = noVNC web UI (base), 9222 = Chromium CDP loopback (base),
# 9223 = bridged CDP on all interfaces (ours).
EXPOSE 3000 9222 9223

# The base launches the visible browser via ${CHROME_CLI}; we add the CDP port.
ENV CHROME_CLI="--remote-debugging-port=9222 --no-first-run --no-default-browser-check --disable-background-networking"
