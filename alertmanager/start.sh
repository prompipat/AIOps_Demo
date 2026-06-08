#!/bin/sh
# Substitute environment variables in alertmanager config
sed "s|\${SLACK_WEBHOOK_URL}|${SLACK_WEBHOOK_URL}|g" /etc/alertmanager/alertmanager.yml > /tmp/alertmanager.yml
# Start alertmanager with the processed config
/bin/alertmanager --config.file=/tmp/alertmanager.yml --log.level=info
