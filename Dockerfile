FROM docker.n8n.io/n8nio/n8n:latest

USER root

# Bundle the chat UI
COPY email-chat.html /usr/local/lib/node_modules/n8n/dist/public/email-chat.html

# Bundle the SQLite database and config (encryption key)
COPY database.sqlite /home/node/.n8n/database.sqlite
COPY n8n-config.json /home/node/.n8n/config
RUN chown -R node:node /home/node/.n8n

USER node

EXPOSE 5678
