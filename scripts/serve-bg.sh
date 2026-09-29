#!/bin/sh
# Restart the built server in the background (dev helper).
[ -f /tmp/carry-server.pid ] && kill "$(cat /tmp/carry-server.pid)" 2>/dev/null
sleep 0.3
PORT=${PORT:-8787} setsid nohup node dist/server/index.js > /tmp/server.log 2>&1 &
echo $! > /tmp/carry-server.pid
