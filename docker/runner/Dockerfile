# Runner image for the MCP Python executor sandbox.
#
# This image runs the python/runner/runner.py entrypoint, which spawns user
# scripts in a child interpreter with a stripped environment. The image
# bakes the medtracker helper package and runner code in at build time so
# the runtime container does NOT need pip — production deployments mount
# the root filesystem read-only, which would prevent installs anyway.
#
# Hardening summary (production deploys layer additional controls in
# docker-compose: read-only root FS, capability drops, network isolation,
# CPU/memory caps, no Docker socket):
#
#   - Non-root user (uid 1000)
#   - No pip cache, no apt sources kept around
#   - Only the proxy URL passed in via env at runtime
#   - Helper package + runner are copied to /opt/medtracker
#   - WORKDIR set to /tmp so scratch writes go to a tmpfs in production

FROM python:3.12-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PYTHONPATH=/opt/medtracker

# Create the runtime user with no shell login. We do not install pip-managed
# packages because the helper has zero runtime dependencies (urllib + json
# from the stdlib).
RUN addgroup -g 1000 runner && \
    adduser -D -u 1000 -G runner -s /sbin/nologin runner

WORKDIR /opt/medtracker

# Copy the helper package and the runner module. Build context for this
# Dockerfile is the repo root (see docker-compose `build:` config).
COPY python/medtracker /opt/medtracker/medtracker
COPY python/runner /opt/medtracker/runner

# Strip pyc caches that may have been copied in.
RUN find /opt/medtracker -type d -name __pycache__ -exec rm -rf {} + && \
    chown -R runner:runner /opt/medtracker

USER runner
WORKDIR /tmp

# The Go execution service spawns this image with the run config on stdin
# and reads the runner envelope from stdout. The `python -m runner.runner`
# form ensures `from runner import limits` resolves regardless of cwd.
ENTRYPOINT ["python", "-m", "runner.runner"]
