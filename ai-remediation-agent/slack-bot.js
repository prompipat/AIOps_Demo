const { App } = require('@slack/bolt');
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || '#alerts';

function initSlackBot() {
  const app = new App({
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET
  });

  return app;
}

async function sendSlackMessage(message, bolt) {
  try {
    await bolt.client.chat.postMessage({
      channel: '#alerts',
      text: message
    });
    console.log('✅ Message sent to Slack');
  } catch (error) {
    console.error('❌ Failed to send Slack message:', error);
  }
}

async function sendSlackApproval(alertContext, analysis, bolt) {
  try {
    const primaryAction = analysis.recommendedActions[0];
    
    const blocks = [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `🚨 Alert: ${alertContext.name}`,
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
          text: `*🤖 AI Analysis*\n*Root Cause:* ${analysis.rootCause}\n*Confidence:* ${analysis.confidence}%`
        }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Recommended Actions:*`
        }
      }
    ];

    // Add action buttons
    analysis.recommendedActions.forEach((action, index) => {
      blocks.push({
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${index + 1}. [${action.priority}] ${action.description}*\nReason: ${action.reason}`
        }
      });
    });

    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '✅ Approve & Execute',
            emoji: true
          },
          value: JSON.stringify({
            action: primaryAction.action,
            service: primaryAction.service,
            alertname: alertContext.name
          }),
          action_id: 'approve_remediation',
          style: 'primary'
        },
        {
          type: 'button',
          text: {
            type: 'plain_text',
            text: '❌ Reject',
            emoji: true
          },
          value: JSON.stringify({
            alertname: alertContext.name
          }),
          action_id: 'reject_remediation',
          style: 'danger'
        }
      ]
    });

    await bolt.client.chat.postMessage({
      channel: '#alerts',
      blocks: blocks,
      text: `Alert: ${alertContext.name} requires remediation`
    });

    console.log('✅ Approval message sent to Slack');
  } catch (error) {
    console.error('❌ Failed to send approval message to Slack:', error);
    throw error;
  }
}

module.exports = {
  initSlackBot,
  sendSlackMessage,
  sendSlackApproval
};