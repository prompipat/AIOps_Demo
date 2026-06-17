const { App } = require('@slack/bolt');
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || '#alerts';

function initSlackBot() {
  return new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET
  });
}

async function sendSlackMessage(message, bolt) {
  try {
    await bolt.client.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      text: message
    });
    console.log('Message sent to Slack');
  } catch (error) {
    console.error('Failed to send Slack message:', error);
  }
}

function formatEvidenceLines(items, fallback = 'none') {
  if (!Array.isArray(items) || items.length === 0) {
    return fallback;
  }

  return items
    .slice(0, 5)
    .map((item) => `- ${item}`)
    .join('\n');
}

async function sendSlackApproval(alertContext, analysis, bolt, actionRequests = []) {
  try {
    const pendingApproval = actionRequests.find((request) => request.status === 'pending_approval');
    const evidenceUsed = analysis.evidenceUsed || {};
    const correlatedSignals = analysis.correlatedSignals || [];
    const missingSignals = analysis.missingSignals || [];
    const traceIds = analysis.traceIds || [];

    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `Alert: ${alertContext.name}`,
          emoji: true
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Service:* ${alertContext.service}\n*Severity:* ${alertContext.severity}\n*Summary:* ${alertContext.summary}`
        }
      },
      {
        type: 'divider'
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*AI Analysis*\n*Root Cause:* ${analysis.rootCause}\n*Confidence:* ${analysis.confidence}%`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Recommended Actions:*`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Evidence Used*\n*Metrics:*\n${formatEvidenceLines(evidenceUsed.metrics)}\n*Logs:*\n${formatEvidenceLines(evidenceUsed.logs)}\n*Traces:*\n${formatEvidenceLines(evidenceUsed.traces)}`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Trace IDs*\n${formatEvidenceLines(traceIds)}`
        }
      }
    ];

    if (correlatedSignals.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Correlated Signals*\n${formatEvidenceLines(correlatedSignals)}`
        }
      });
    }

    if (missingSignals.length > 0) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Missing Signals*\n${formatEvidenceLines(missingSignals)}`
        }
      });
    }

    blocks.push({
      type: 'divider'
    });

    analysis.recommendedActions.forEach((action, index) => {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${index + 1}. [${action.priority}] ${action.description}*\nReason: ${action.reason}`
        }
      });
    });

    if (pendingApproval) {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Pending Approval*\nAction: \`${pendingApproval.action}\`\nService: \`${pendingApproval.service}\`\nRisk: *${pendingApproval.risk}*`
        }
      });

      blocks.push({
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Approve & Execute',
              emoji: true
            },
            value: JSON.stringify({
              actionId: pendingApproval.id,
              alertname: alertContext.name
            }),
            action_id: 'approve_remediation',
            style: 'primary'
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Reject',
              emoji: true
            },
            value: JSON.stringify({
              actionId: pendingApproval.id,
              alertname: alertContext.name
            }),
            action_id: 'reject_remediation',
            style: 'danger'
          }
        ]
      });
    } else {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*Approval:* No high-risk action is pending. Low-risk actions were auto-executed or unsupported actions were blocked.'
        }
      });
    }

    await bolt.client.chat.postMessage({
      channel: SLACK_CHANNEL_ID,
      blocks,
      text: `Alert: ${alertContext.name} requires remediation`
    });

    console.log('Approval message sent to Slack');
  } catch (error) {
    console.error('Failed to send approval message to Slack:', error);
    throw error;
  }
}

module.exports = {
  initSlackBot,
  sendSlackMessage,
  sendSlackApproval
};
