#!/bin/sh
# Copy seed database and config to the writable n8n data directory
if [ ! -f /home/node/.n8n/database.sqlite ]; then
  cp /opt/n8n-seed/database.sqlite /home/node/.n8n/database.sqlite
  cp /opt/n8n-seed/config /home/node/.n8n/config
fi

# Launch n8n
exec n8n
