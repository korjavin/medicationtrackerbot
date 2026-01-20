#!/bin/sh
set -e

# Auto-fix permissions for data directory when running as root
# This allows the container to handle volumes created by previous root user
if [ "$(id -u)" = "0" ]; then
    echo "Running as root, fixing /app/data permissions..."
    
    # Ensure /app/data exists
    mkdir -p /app/data
    
    # Fix ownership to appuser (UID 1000)
    chown -R appuser:appuser /app/data
    
    echo "Permissions fixed. Switching to appuser..."
    # Use su-exec to drop privileges and exec the command
    exec su-exec appuser "$@"
fi

# Already running as appuser
echo "Running as appuser ($(id -u):$(id -g))"
exec "$@"
