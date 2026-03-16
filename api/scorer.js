const https = require('https');
const http = require('http');

const RPC_URL = 'https://mainnet.helius-rpc.com/?api-key=YOUR_KEY';

// === SOLANA RPC HELPER ===
function rpcCall(method, params = []) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
    const url = new URL(RPC_URL);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 15000
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) reject(new Error(json.error.message));
          else resolve(json.result);
        } catch (e) { reject(e); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('RPC timeout')); });
    req.write(data);
    req.end();
  });
}

// === SCORING FUNCTIONS ===

async function getWalletAge(wallet) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [wallet, { limit: 1000, commitment: 'confirmed' }]);
    if (!sigs || sigs.length === 0) return { days: 0, score: 0 };
    const oldest = sigs[sigs.length - 1];
    if (!oldest || !oldest.blockTime) return { days: 0, score: 0 };
    const ageSeconds = Math.floor(Date.now() / 1000) - oldest.blockTime;
    const ageDays = Math.floor(ageSeconds / 86400);
    let score;
    if (ageDays < 7) score = 5;
    else if (ageDays < 30) score = 20;
    else if (ageDays < 90) score = 45;
    else if (ageDays < 180) score = 70;
    else if (ageDays < 365) score = 85;
    else score = 100;
    return { days: ageDays, score };
  } catch (e) {
    console.error('getWalletAge error:', e.message);
    return { days: 0, score: 0 };
  }
}

async function getTransactionActivity(wallet) {
  try {
    // Get recent transaction signatures (up to 100)
    const sigs = await rpcCall('getSignaturesForAddress', [
      wallet, { limit: 100, commitment: 'confirmed' }
    ]);

    if (!sigs || sigs.length === 0) {
      return { totalTxs: 0, successRate: 0, score: 0, recentActivity: false };
    }

    const totalTxs = sigs.length;
    const successfulTxs = sigs.filter(s => s.err === null).length;
    const failedTxs = totalTxs - successfulTxs;
    const successRate = totalTxs > 0 ? Math.round((successfulTxs / totalTxs) * 100) : 0;

    // Check recent activity (last 7 days)
    const oneWeekAgo = Math.floor(Date.now() / 1000) - (7 * 86400);
    const recentTxs = sigs.filter(s => s.blockTime && s.blockTime > oneWeekAgo);
    const recentActivity = recentTxs.length > 0;

    // Score based on volume + success rate
    let volumeScore;
    if (totalTxs < 5) volumeScore = 10;
    else if (totalTxs < 20) volumeScore = 30;
    else if (totalTxs < 50) volumeScore = 55;
    else if (totalTxs < 100) volumeScore = 75;
    else volumeScore = 95;

    // Penalize high failure rate
    let successPenalty = 0;
    if (successRate < 50) successPenalty = 40;
    else if (successRate < 70) successPenalty = 25;
    else if (successRate < 85) successPenalty = 10;

    // Bonus for recent activity
    const activityBonus = recentActivity ? 5 : -10;

    const score = Math.max(0, Math.min(100, volumeScore - successPenalty + activityBonus));

    return { totalTxs, successfulTxs, failedTxs, successRate, recentActivity, score };
  } catch (e) {
    console.error('getTransactionActivity error:', e.message);
    return { totalTxs: 0, successRate: 0, score: 0, recentActivity: false };
  }
}

async function getBalance(wallet) {
  try {
    const result = await rpcCall('getBalance', [wallet, { commitment: 'confirmed' }]);
    const solBalance = (result.value || 0) / 1e9; // lamports to SOL

    // Score based on balance (skin in the game)
    let score;
    if (solBalance < 0.01) score = 5;
    else if (solBalance < 0.1) score = 15;
    else if (solBalance < 1) score = 30;
    else if (solBalance < 10) score = 50;
    else if (solBalance < 100) score = 70;
    else if (solBalance < 1000) score = 85;
    else score = 95;

    return { solBalance: Math.round(solBalance * 1000) / 1000, score };
  } catch (e) {
    console.error('getBalance error:', e.message);
    return { solBalance: 0, score: 0 };
  }
}

async function getCounterpartyDiversity(wallet) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [
      wallet, { limit: 50, commitment: 'confirmed' }
    ]);

    if (!sigs || sigs.length === 0) {
      return { uniqueCounterparties: 0, score: 0 };
    }

    // We can't easily get counterparties without parsing each tx
    // Instead, use signature count as a proxy for diversity
    // More transactions over time = likely more diverse interactions
    const txCount = sigs.length;

    // Check time spread - are txs spread out or clustered?
    const times = sigs.filter(s => s.blockTime).map(s => s.blockTime).sort();
    let spreadScore = 50;

    if (times.length >= 2) {
      const timeRange = times[times.length - 1] - times[0];
      const avgGap = timeRange / (times.length - 1);

      // Good spread = transactions aren't all clustered together
      if (avgGap > 86400) spreadScore = 80; // >1 day between txs
      else if (avgGap > 3600) spreadScore = 60; // >1 hour
      else if (avgGap > 300) spreadScore = 40; // >5 min
      else spreadScore = 20; // very clustered = suspicious
    }

    let score;
    if (txCount < 5) score = Math.min(spreadScore, 20);
    else if (txCount < 20) score = Math.min(spreadScore, 50);
    else score = spreadScore;

    return { txCount, spreadScore, score };
  } catch (e) {
    console.error('getCounterpartyDiversity error:', e.message);
    return { uniqueCounterparties: 0, score: 0 };
  }
}


async function detectAnomalies(wallet) {
  try {
    const sigs = await rpcCall('getSignaturesForAddress', [wallet, { limit: 100, commitment: 'confirmed' }]);
    if (!sigs || sigs.length < 2) return { anomalies: [], penalty: 0, flags: 0 };

    const anomalies = [];
    let penalty = 0;

    const balResult = await rpcCall('getBalance', [wallet, { commitment: 'confirmed' }]);
    const currentBal = (balResult.value || 0) / 1e9;

    const failedTxs = sigs.filter(s => s.err !== null);
    const failRate = sigs.length > 0 ? failedTxs.length / sigs.length : 0;
    if (failRate > 0.3) {
      anomalies.push({ type: 'HIGH_FAIL_RATE', detail: Math.round(failRate * 100) + '% of transactions failed', severity: 'medium' });
      penalty += 15;
    }

    const times = sigs.filter(s => s.blockTime).map(s => s.blockTime).sort((a, b) => a - b);

    if (times.length > 0) {
      const walletAgeDays = (Math.floor(Date.now() / 1000) - times[0]) / 86400;
      if (walletAgeDays < 30 && currentBal > 100) {
        anomalies.push({ type: 'NEW_WHALE', detail: 'Wallet is ' + Math.round(walletAgeDays) + ' days old with ' + Math.round(currentBal) + ' SOL', severity: 'medium' });
        penalty += 5;
      }
      if (walletAgeDays < 14 && currentBal > 1000) {
        anomalies.push({ type: 'SUSPICIOUS_TREASURY', detail: 'Very new wallet holding ' + Math.round(currentBal) + ' SOL', severity: 'high' });
        penalty += 10;
      }
    }

    if (times.length >= 10) {
      const windows = [];
      for (let i = 0; i < times.length - 9; i++) {
        windows.push(times[i + 9] - times[i]);
      }
      if (Math.min(...windows) < 60) {
        anomalies.push({ type: 'BURST_ACTIVITY', detail: '10+ transactions within 60 seconds', severity: 'low' });
        penalty += 5;
      }
    }

    penalty = Math.min(penalty, 60);
    return { anomalies, penalty, flags: anomalies.length };
  } catch (e) {
    console.error('detectAnomalies error:', e.message);
    return { anomalies: [], penalty: 0, flags: 0 };
  }
}

// === MAIN SCORER ===
async function calculateOnChainScore(wallet) {
  console.log('[Scorer] Calculating on-chain score for ' + wallet.slice(0, 8) + '...');

  const [age, activity, balance, diversity, anomalyResult] = await Promise.all([
    getWalletAge(wallet),
    getTransactionActivity(wallet),
    getBalance(wallet),
    getCounterpartyDiversity(wallet),
    detectAnomalies(wallet)
  ]);

  let onChainScore = Math.round(
    (age.score * 0.25) +
    (activity.score * 0.35) +
    (balance.score * 0.15) +
    (diversity.score * 0.25)
  );

  onChainScore = Math.max(0, onChainScore - anomalyResult.penalty);

  const breakdown = {
    age: { days: age.days, score: age.score },
    activity: { totalTxs: activity.totalTxs, successRate: activity.successRate, recentActivity: activity.recentActivity, score: activity.score },
    balance: { sol: balance.solBalance, score: balance.score },
    diversity: { score: diversity.score },
    anomalies: anomalyResult.anomalies,
    anomalyPenalty: anomalyResult.penalty,
    onChainScore,
    calculatedAt: new Date().toISOString()
  };

  console.log('[Scorer] ' + wallet.slice(0, 8) + '... => score: ' + onChainScore + (anomalyResult.penalty > 0 ? ' (penalty: -' + anomalyResult.penalty + ')' : ''));
  return breakdown;
}

// === COMPOSITE REPUTATION ===
// Combines on-chain (60%), vouching (25%), endorsements (15%)
function calculateCompositeScore(onChainScore, vouchScore, endorsementScore = 0) {
  return Math.round(
    (onChainScore * 0.60) +
    (vouchScore * 0.25) +
    (endorsementScore * 0.15)
  );
}

module.exports = { calculateOnChainScore, calculateCompositeScore };

