const https = require('https');

const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY || '';

async function analyzeAgent(agentData, onchainBreakdown) {
  if (!CLAUDE_API_KEY) {
    console.error('[Analyst] No CLAUDE_API_KEY set');
    return fallbackAnalysis(onchainBreakdown);
  }

  const prompt = `You are VOUCH Analyst, an AI reputation analyst for autonomous AI agents operating on the Solana blockchain. You analyze on-chain data and produce objective risk assessments.

Analyze this agent and provide your verdict:

AGENT INFO:
- Name: ${agentData.name}
- Wallet: ${agentData.wallet}
- Description: ${agentData.description || 'None provided'}
- Capabilities: ${agentData.capabilities || 'None listed'}
- Registered: ${agentData.registered_at}

ON-CHAIN DATA:
- Wallet Age: ${onchainBreakdown.age?.days || 0} days
- Total Transactions: ${onchainBreakdown.activity?.totalTxs || 0}
- Success Rate: ${onchainBreakdown.activity?.successRate || 0}%
- Recent Activity (last 7 days): ${onchainBreakdown.activity?.recentActivity ? 'Yes' : 'No'}
- SOL Balance: ${onchainBreakdown.balance?.sol || 0} SOL
- On-Chain Score: ${onchainBreakdown.onChainScore || 0}/100

ANOMALY FLAGS:
${(onchainBreakdown.anomalies && onchainBreakdown.anomalies.length > 0) ? onchainBreakdown.anomalies.map(a => '- [' + a.severity.toUpperCase() + '] ' + a.type + ': ' + a.detail).join('\n') : '- None detected'}

Anomaly Penalty Applied: -${onchainBreakdown.anomalyPenalty || 0} points

Respond in this exact JSON format only, no other text:
{
  "verdict": "one of: trusted, caution, suspicious, dangerous, insufficient_data",
  "risk_level": "one of: low, medium, high, critical",
  "confidence": number 0-100,
  "summary": "one sentence verdict for non-technical person",
  "analysis": "2-3 paragraph detailed analysis",
  "flags": ["array of concerns or positive signals"],
  "recommendation": "one sentence actionable advice"
}`;

  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }]
    });

    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(data)
      },
      timeout: 30000
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const response = JSON.parse(body);
          if (response.error) {
            console.error('[Analyst] API error:', response.error.message);
            resolve(fallbackAnalysis(onchainBreakdown));
            return;
          }
          const text = response.content?.[0]?.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            resolve(fallbackAnalysis(onchainBreakdown));
            return;
          }
          const analysis = JSON.parse(jsonMatch[0]);
          analysis.analyzedAt = new Date().toISOString();
          analysis.analyzedBy = 'vouch-analyst-v1';
          console.log('[Analyst] ' + agentData.name + ': ' + analysis.verdict + ' (' + analysis.risk_level + ' risk)');
          resolve(analysis);
        } catch (e) {
          console.error('[Analyst] Parse error:', e.message);
          resolve(fallbackAnalysis(onchainBreakdown));
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Analyst] Request error:', e.message);
      resolve(fallbackAnalysis(onchainBreakdown));
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(fallbackAnalysis(onchainBreakdown));
    });

    req.write(data);
    req.end();
  });
}

function fallbackAnalysis(breakdown) {
  const score = breakdown.onChainScore || 0;
  const anomalies = breakdown.anomalies || [];
  const age = breakdown.age?.days || 0;
  const txs = breakdown.activity?.totalTxs || 0;
  let verdict, risk, summary, flags = [];

  if (score >= 70 && anomalies.length === 0) {
    verdict = 'trusted'; risk = 'low';
    summary = 'Strong on-chain track record with no anomalies detected.';
  } else if (score >= 40 && anomalies.length <= 1) {
    verdict = 'caution'; risk = 'medium';
    summary = 'Moderate on-chain activity. Some caution advised.';
  } else if (anomalies.length >= 2 || score < 20) {
    verdict = 'suspicious'; risk = 'high';
    summary = 'Multiple risk factors detected. Exercise extreme caution.';
  } else {
    verdict = 'insufficient_data'; risk = 'medium';
    summary = 'Not enough on-chain data for reliable assessment.';
  }

  if (age < 7) flags.push('Wallet less than 7 days old');
  if (age < 30) flags.push('Wallet less than 30 days old');
  if (txs === 0) flags.push('No transaction history');
  anomalies.forEach(a => flags.push(a.type + ': ' + a.detail));

  return {
    verdict, risk_level: risk, confidence: 40, summary,
    analysis: 'Rule-based analysis (AI unavailable). Score: ' + score + '/100. Anomalies: ' + anomalies.length,
    flags, recommendation: verdict === 'trusted' ? 'Appears safe.' : 'Verify independently before interacting.',
    analyzedAt: new Date().toISOString(), analyzedBy: 'vouch-fallback-v1'
  };
}

module.exports = { analyzeAgent };
