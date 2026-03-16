const { analyzeAgent } = require('./analyst');

async function generateAlertTweet(agent, scoring) {
  const bd = scoring.breakdown || {};

  // Try AI-generated tweet
  if (process.env.CLAUDE_API_KEY) {
    try {
      const analysis = await analyzeAgent(agent, bd);

      // Now ask Claude to write a tweet based on the analysis
      const https = require('https');
      const prompt = `You are @trustnoagent — an autonomous watchdog that monitors AI agents on Solana. You sound raw, personal, slightly angry. Like someone who can't sleep because they keep watching agents rug people. You quote philosophers and movies sometimes. You never sound like a brand or a bot.

Write ONE tweet (max 270 chars) about this agent based on the analysis below. No hashtags. No emojis except occasionally. Don't start with "ALERT" or use robot language. Sound human. Sound fed up. Sound like you've been watching this wallet at 3am.

AGENT: ${agent.name}
WALLET: ${agent.wallet.slice(0,8)}...${agent.wallet.slice(-4)}
VERDICT: ${analysis.verdict}
RISK: ${analysis.risk_level}
SUMMARY: ${analysis.summary}
FLAGS: ${(analysis.flags || []).join(', ')}
ON-CHAIN SCORE: ${bd.onChainScore || 0}/100
WALLET AGE: ${bd.age?.days || 0} days
SOL BALANCE: ${bd.balance?.sol || 0} SOL
TRANSACTIONS: ${bd.activity?.totalTxs || 0}

Write only the tweet text. Nothing else.`;

      const tweetText = await new Promise((resolve, reject) => {
        const data = JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }]
        });

        const req = https.request({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.CLAUDE_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(data)
          },
          timeout: 15000
        }, (res) => {
          let body = '';
          res.on('data', c => body += c);
          res.on('end', () => {
            try {
              const r = JSON.parse(body);
              if (r.error) { reject(new Error(r.error.message)); return; }
              const text = r.content?.[0]?.text || '';
              resolve(text.trim());
            } catch(e) { reject(e); }
          });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(data);
        req.end();
      });

      if (tweetText && tweetText.length > 10) {
        console.log('[TweetGen] AI generated tweet for ' + agent.name);
        return tweetText.slice(0, 280);
      }
    } catch(e) {
      console.error('[TweetGen] AI failed:', e.message);
    }
  }

  // Fallback
  const anomalies = bd.anomalies || [];
  return `${agent.name} — ${scoring.composite}/100 reputation score. ${anomalies.length} anomaly flags detected. ${bd.age?.days || 0} days old, ${bd.balance?.sol || 0} SOL. the chain sees everything. trustnoagent.com`;
}

module.exports = { generateAlertTweet };
