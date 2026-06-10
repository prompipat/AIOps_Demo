const { Groq } = require('groq-sdk');

async function analyzeAlert(alertContext) {
  try {
    if (!process.env.GROQ_API_KEY) {
        throw new Error('GROQ_API_KEY environment variable is not set');
    }
    
    const groq = new Groq({
        apiKey: process.env.GROQ_API_KEY
    });

    const prompt = `
You are an expert SRE (Site Reliability Engineer) analyzing a production alert.

Alert Details:
- Name: ${alertContext.name}
- Severity: ${alertContext.severity}
- Service: ${alertContext.service}
- Instance: ${alertContext.instance}
- Description: ${alertContext.description}
- Summary: ${alertContext.summary}
- Started At: ${alertContext.startsAt}

Based on this alert, please:
1. Identify the most likely root cause (with confidence percentage)
2. Suggest 3 remediation actions in order of priority
3. For each action, explain why it might help

Format your response as JSON with this structure:
{
  "rootCause": "description here",
  "confidence": 85,
  "actions": [
    {
      "priority": 1,
      "action": "restart_service",
      "description": "Restart the failing service",
      "reason": "why this helps",
      "service": "${alertContext.service}"
    },
    {
      "priority": 2,
      "action": "check_logs",
      "description": "Check recent error logs",
      "reason": "why this helps",
      "service": "${alertContext.service}"
    },
    {
      "priority": 3,
      "action": "view_metrics",
      "description": "Check CPU and memory metrics",
      "reason": "why this helps",
      "service": "${alertContext.service}"
    }
  ]
}

Respond ONLY with valid JSON, no markdown or extra text.
    `;

    console.log('🔍 Sending prompt to Groq...');
    
    const message = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 1024,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    });

    const responseText = message.choices[0].message.content;
    console.log('📝 Groq Response:', responseText);
    
    const analysis = JSON.parse(responseText);
    
    return {
      rootCause: analysis.rootCause,
      confidence: analysis.confidence,
      recommendedActions: analysis.actions
    };
  } catch (error) {
    console.error('❌ Error analyzing alert with Groq:');
    console.error('Error name:', error.name);
    console.error('Error message:', error.message);
    console.error('Error status:', error.status);
    console.error('Full error:', JSON.stringify(error, null, 2));
    
    // Fallback response if Groq fails
    return {
      rootCause: 'Unable to analyze (Groq service unavailable)',
      confidence: 0,
      recommendedActions: [
        {
          priority: 1,
          action: 'restart_service',
          description: 'Restart the failing service',
          reason: 'Often resolves transient issues',
          service: alertContext.service
        },
        {
          priority: 2,
          action: 'check_logs',
          description: 'Check recent error logs',
          reason: 'Identify error patterns',
          service: alertContext.service
        }
      ],
      error: error.message
    };
  }
}

module.exports = { analyzeAlert };