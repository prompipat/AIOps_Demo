const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
require('dotenv').config();

const { initSlackBot, sendSlackMessage, sendSlackApproval } = require('./slack-bot');
const { analyzeAlert } = require('./groq-analyzer');

const app = express();
const PORT = process.env.PORT || 3003;

app.use(bodyParser.json());

const bolt = initSlackBot();

function resolveServiceFromAlert(alert) {
    const labels = alert.labels || {};
    if (labels.service) {
        return labels.service;
    }

    const alertname = labels.alertname || '';
    const team = labels.team || '';

    if (alertname.includes('Payment') || team === 'payments') {
        return 'payment-service';
    }

    if (alertname.includes('Order') || team === 'orders') {
        return 'order-service';
    }

    if (alertname.includes('API') || team === 'platform') {
        return 'api-gateway';
    }

    return 'unknown';
}

// Health Check
app.get('/health', (req, res) => {
    res.json({status: 'ok', service: 'ai-remediation-agent'});
});

// Receive alerts from Alertmanager
app.post('/alerts', async(req, res) => {
    try {
        const alerts = req.body.alerts || [];

        console.log(`📩 Received ${alerts.length} alert(s)`)

        for (const alert of alerts) {
            if (alert.status === 'firing') {
                console.log(`🚨 Processing alert: ${alert.labels.alertname}`)
                // Extract alert context
                const alertContext = {
                    name: alert.labels.alertname,
                    severity: alert.labels.severity || 'unknown',
                    service: resolveServiceFromAlert(alert),
                    instance: alert.labels.instance || 'unknown',
                    description: alert.annotations.description || '',
                    summary: alert.annotations.summary || '',
                    startsAt: alert.startsAt,
                    endsAt: alert.endsAt
                };
                console.log('📋 Alert Context:', alertContext);

                // Send to Groq for analysis
                console.log('🤖 Analyzing with Groq...');
                const analysis = await analyzeAlert(alertContext);
                console.log('✨ Analysis Result:', analysis);

                // Send approval request to Slack with buttons
                console.log('📤 Sending approval request to Slack...');
                await sendSlackApproval(alertContext, analysis, bolt);
            }
        }
        res.json({ status: 'received', count: alerts.length });
    } catch (error) {
        console.error('❌ Error processing alerts:', error);
        res.status(500).json({ error: error.message });
    }
});

// Handle Slack button interactions (approve/reject)
bolt.action('approve_remediation', async ({ body, ack, say }) => {
    await ack();

    const metadata = JSON.parse(body.action[0].value);
    console.log(`✅ User ${body.user.name} approved action: ${metadata.action}`);

    // Execute the remediation action
    try {
        const result = await executeAction(metadata);

        await say({
            text: `✅ Remediation executed successfully!\n${result}`,
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `✅ *Remediation Executed*\n\`\`\`${result}\`\`\``
                    }
                }
            ]
        });
    } catch (error) {
        await say({
            text: `❌ Remediation failed: ${error.message}`,
            blocks: [
                {
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `❌ *Remediation Failed*\n\`\`\`${error.message}\`\`\``
                }
                }
            ]
        });
    }
});

bolt.action('reject_remediation', async ({ body, ack, say }) => {
    await ack();

    console.log(`❌ User ${body.user.name} rejected remediation`);
  
    await say({
        text: '❌ Remediation rejected by user. Manual intervention required.',
        blocks: [
        {
            type: 'section',
            text: {
            type: 'mrkdwn',
            text: `❌ *Remediation Rejected*\nNo automatic action taken. Please investigate manually.`
            }
        }
        ]
    });
});

// Execute remediation action (safe actions only)
async function executeAction(metadata) {
    const { action, service } = metadata;

    switch (action) {
        case 'restart_service':
            console.log(`🔄 Restarting service: ${service}`);
            // In Docker Compose environment
            const { execSync } = require('child_process');
            const output = execSync(`docker-compose restart ${service}`, {
                cwd: '/app',
                encoding: 'utf-8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            return `Service ${service} restarted.\n${output}`;
        
        case 'check_logs':
            console.log(`📝 Checking logs for: ${service}`)
            const logs = execSync(`docker-compose logs --tail=20 ${service}`, {
                cwd: '/app',
                encoding: 'utf-8'
            });
            return `Recent logs from ${service}:\n\`\`\`\n${logs}\n\`\`\``;

        case 'view_metrics':
            console.log(`📊 Fetching metrics from Prometheus`);
            const metricsResponse = await axios.get(
                'http://prometheus:9090/api/v1/query', 
                { params: { query: `rate(otel_request_errors{service="${service}"}[5m])` }}
            );
            const errorRate = metricsResponse.data.data.result[0]?.value[1] || 'N/A';
            return `Error rate for ${service}: ${errorRate}`;
        
        default:
            throw new Error(`Unknown action: ${action}`)
    }
}

app.listen(PORT, () => {
    console.log(`✅ AI Remediation Agent listening on port ${PORT}`);
    console.log(`📍 Alert webhook: http://localhost:${PORT}/alerts`);
});

// Start Slack bot
// bolt.start(process.env.PORT || 3000).catch(err => {
//     console.error('❌ Failed to start Slack bot:', err)
// })

// Slack events endpoint
app.post('/slack/events', async (req, res) => {
    await bolt.processEvent(req);
    res.status(200).end();
});

// Important: Start Slack bot BEFORE Express
bolt.start(process.env.SLACK_PORT || 3000).then(() => {
    console.log('✅ Slack bot started');
});

module.exports = app;
