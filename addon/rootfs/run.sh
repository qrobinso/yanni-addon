#!/bin/sh
# Options come from /data/options.json, the HA token from SUPERVISOR_TOKEN, MQTT from the Supervisor's services API.
exec node /app/main.js
