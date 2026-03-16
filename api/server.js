const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const { calculateOnChainScore, calculateCompositeScore } = require('./scorer');

const { createAccessControl } = require('./middleware');
const app = express();
app.use(cors());
app.use(express.json());

// === DATABASE ===
const db = new Database(path.join(__dirname, 'vouch.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    wallet TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    capabilities TEXT,
    website TEXT,
    registered_at TEXT NOT NULL DEFAULT (datetime('now')),
    reputation_score REAL NOT NULL DEFAULT 0,
    onchain_score REAL NOT NULL DEFAULT 0,
    vouch_score REAL NOT NULL DEFAULT 0,
    endorsement_score REAL NOT NULL DEFAULT 0,
    total_vouches INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    onchain_data TEXT DEFAULT '{}',
    last_scored TEXT
  );

  CREATE TABLE IF NOT EXISTS vouches (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    voucher_wallet TEXT NOT NULL,
    comment TEXT,
    score INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_id) REFERENCES agents(id)
  );

  CREATE TABLE IF NOT EXISTS queries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT,
    queried_at TEXT NOT NULL DEFAULT (datetime('now')),
    ip TEXT
  );
`);

// Migrate existing db
try { db.exec('ALTER TABLE agents ADD COLUMN onchain_score REAL NOT NULL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE agents ADD COLUMN vouch_score REAL NOT NULL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE agents ADD COLUMN endorsement_score REAL NOT NULL DEFAULT 0'); } catch(e) {}
try { db.exec('ALTER TABLE agents ADD COLUMN onchain_data TEXT DEFAULT "{}"'); } catch(e) {}
try { db.exec('ALTER TABLE agents ADD COLUMN last_scored TEXT'); } catch(e) {}

const stmts = {
  insertAgent: db.prepare('INSERT INTO agents (id, wallet, name, description, capabilities, website) VALUES (?, ?, ?, ?, ?, ?)'),
  getAgentByWallet: db.prepare('SELECT * FROM agents WHERE wallet = ?'),
  getAgentById: db.prepare('SELECT * FROM agents WHERE id = ?'),
  listAgents: db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY reputation_score DESC, registered_at ASC LIMIT ? OFFSET ?'),
  countAgents: db.prepare('SELECT COUNT(*) as count FROM agents WHERE status = ?'),
  insertVouch: db.prepare('INSERT INTO vouches (id, agent_id, voucher_wallet, comment, score) VALUES (?, ?, ?, ?, ?)'),
  getVouches: db.prepare('SELECT * FROM vouches WHERE agent_id = ? ORDER BY created_at DESC LIMIT 20'),
  countVouches: db.prepare('SELECT COUNT(*) as count FROM vouches WHERE agent_id = ?'),
  updateScores: db.prepare('UPDATE agents SET reputation_score = ?, onchain_score = ?, vouch_score = ?, total_vouches = ?, onchain_data = ?, last_scored = datetime(?) WHERE id = ?'),
  updateVouchScore: db.prepare('UPDATE agents SET vouch_score = ?, total_vouches = ?, reputation_score = ? WHERE id = ?'),
  logQuery: db.prepare('INSERT INTO queries (agent_id, ip) VALUES (?, ?)'),
  countQueries: db.prepare('SELECT COUNT(*) as count FROM queries'),
  getAllActive: db.prepare('SELECT * FROM agents WHERE status = ?'),
};

// === API ACCESS CONTROL ===
const { accessControl, generateApiKey, addCredits, getUsageStats } = createAccessControl(db);
app.use(accessControl);

function genId() { return crypto.randomBytes(8).toString('hex'); }

function calcVouchScore(agentId) {
  const { count } = stmts.countVouches.get(agentId);
  if (count === 0) return { score: 0, count: 0 };
  const avg = db.prepare('SELECT AVG(score) as avg FROM vouches WHERE agent_id = ?').get(agentId);
  const confidence = Math.min(count / 5, 1);
  const score = Math.round((avg.avg || 0) * 20 * confidence * 100) / 100;
  return { score, count };
}

// === ROUTES ===

app.post('/api/agents/register', (req, res) => {
  const { wallet, name, description, capabilities, website } = req.body;
  if (!wallet || !name) return res.status(400).json({ error: 'wallet and name are required' });
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return res.status(400).json({ error: 'invalid solana wallet address' });

  const existing = stmts.getAgentByWallet.get(wallet);
  if (existing) return res.status(409).json({ error: 'agent already registered', agent: existing });

  const id = genId();
  try {
    stmts.insertAgent.run(id, wallet, name.slice(0, 100), (description || '').slice(0, 500), (capabilities || '').slice(0, 300), (website || '').slice(0, 200));
    const agent = stmts.getAgentById.get(id);
    scoreAgent(agent).catch(e => console.error('Initial scoring failed:', e.message));
    res.status(201).json({ success: true, agent });
  } catch (err) {
    res.status(500).json({ error: 'registration failed' });
  }
});

app.get('/api/agents/:wallet', (req, res) => {
  const agent = stmts.getAgentByWallet.get(req.params.wallet);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  stmts.logQuery.run(agent.id, req.ip);
  const vouches = stmts.getVouches.all(agent.id);
  let onchainData = {};
  try { onchainData = JSON.parse(agent.onchain_data || '{}'); } catch(e) {}

  res.json({
    agent,
    vouches,
    scoring: {
      composite: agent.reputation_score,
      onchain: agent.onchain_score,
      vouch: agent.vouch_score,
      endorsement: agent.endorsement_score,
      breakdown: onchainData,
      lastScored: agent.last_scored
    }
  });
});

app.get('/api/agents', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const agents = stmts.listAgents.all('active', limit, offset);
  const { count } = stmts.countAgents.get('active');
  res.json({ agents, pagination: { page, limit, total: count, pages: Math.ceil(count / limit) } });
});

app.post('/api/agents/:wallet/vouch', (req, res) => {
  const { voucher_wallet, comment, score } = req.body;
  if (!voucher_wallet) return res.status(400).json({ error: 'voucher_wallet is required' });

  const agent = stmts.getAgentByWallet.get(req.params.wallet);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  if (voucher_wallet === req.params.wallet) return res.status(400).json({ error: 'cannot vouch for yourself' });

  const vouchVal = Math.min(5, Math.max(1, parseInt(score) || 1));
  const id = genId();

  try {
    stmts.insertVouch.run(id, agent.id, voucher_wallet, (comment || '').slice(0, 300), vouchVal);
    const { score: newVouch, count } = calcVouchScore(agent.id);
    const composite = calculateCompositeScore(agent.onchain_score, newVouch, agent.endorsement_score || 0);
    stmts.updateVouchScore.run(newVouch, count, composite, agent.id);
    const updated = stmts.getAgentById.get(agent.id);
    res.status(201).json({ success: true, agent: updated });
  } catch (err) {
    res.status(500).json({ error: 'vouch failed' });
  }
});

app.post('/api/agents/:wallet/rescore', async (req, res) => {
  const agent = stmts.getAgentByWallet.get(req.params.wallet);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  try {
    const result = await scoreAgent(agent);
    const updated = stmts.getAgentByWallet.get(req.params.wallet);
    res.json({ success: true, agent: updated, scoring: result });
  } catch (e) {
    res.status(500).json({ error: 'scoring failed: ' + e.message });
  }
});

app.post('/api/rescore-all', async (req, res) => {
  const agents = stmts.getAllActive.all('active');
  const results = [];
  for (const agent of agents) {
    try {
      const result = await scoreAgent(agent);
      results.push({ wallet: agent.wallet, name: agent.name, ...result });
      await new Promise(r => setTimeout(r, 500));
    } catch (e) {
      results.push({ wallet: agent.wallet, name: agent.name, error: e.message });
    }
  }
  res.json({ scored: results.length, results });
});

app.get('/api/stats', (req, res) => {
  const { count: totalAgents } = stmts.countAgents.get('active');
  const { count: totalQueries } = stmts.countQueries.get();
  const totalVouches = db.prepare('SELECT COUNT(*) as count FROM vouches').get().count;
  const topAgents = db.prepare("SELECT wallet, name, reputation_score, onchain_score, vouch_score, total_vouches FROM agents WHERE status = 'active' ORDER BY reputation_score DESC LIMIT 5").all();
  const usage = getUsageStats();
  res.json({
    network: 'solana', version: '0.3.0',
    scoring: { model: 'composite', weights: { onchain: 0.60, vouch: 0.25, endorsement: 0.15 } },
    stats: { totalAgents, totalVouches, totalQueries },
    usage,
    topAgents
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '0.2.0', uptime: process.uptime() });
});

// === SCORING ENGINE ===
async function scoreAgent(agent) {
  const onchainResult = await calculateOnChainScore(agent.wallet);
  const { score: vouchScore, count: vouchCount } = calcVouchScore(agent.id);
  const composite = calculateCompositeScore(onchainResult.onChainScore, vouchScore, agent.endorsement_score || 0);
  const now = new Date().toISOString();
  stmts.updateScores.run(composite, onchainResult.onChainScore, vouchScore, vouchCount, JSON.stringify(onchainResult), now, agent.id);
  return { composite, onchain: onchainResult.onChainScore, vouch: vouchScore, breakdown: onchainResult };
}

// Background scoring: 10s after start, then every 6 hours
async function backgroundScoring() {
  console.log('[Scorer] Background scoring started...');
  const agents = stmts.getAllActive.all('active');
  for (const agent of agents) {
    try {
      const result = await scoreAgent(agent);
      if (typeof checkAndAlert === 'function') {
        await checkAndAlert(agent, result).catch(e => console.error('[Alert] Error:', e.message));
      }
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error('[Scorer] Failed for ' + agent.name + ':', e.message);
    }
  }
  console.log('[Scorer] Done. Scored ' + agents.length + ' agents.');
}

setTimeout(() => backgroundScoring().catch(console.error), 10000);
setInterval(() => backgroundScoring().catch(console.error), 6 * 60 * 60 * 1000);

const PORT = 3001;
app.listen(PORT, '127.0.0.1', () => {
  console.log('VOUCH API v0.2.0 running on port ' + PORT);
});


const { analyzeAgent: runAnalysis } = require('./analyst');

app.post('/api/agents/:wallet/analyze', async (req, res) => {
  const agent = stmts.getAgentByWallet.get(req.params.wallet);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  let breakdown = {};
  try { breakdown = JSON.parse(agent.onchain_data || '{}'); } catch(e) {}
  try {
    const analysis = await runAnalysis(agent, breakdown);
    try { db.exec('ALTER TABLE agents ADD COLUMN ai_analysis TEXT DEFAULT "{}"'); } catch(e) {}
    db.prepare('UPDATE agents SET ai_analysis = ? WHERE id = ?').run(JSON.stringify(analysis), agent.id);
    res.json({ success: true, agent: agent.name, analysis });
  } catch(e) {
    res.status(500).json({ error: 'analysis failed: ' + e.message });
  }
});

app.get('/api/agents/:wallet/analysis', (req, res) => {
  const agent = stmts.getAgentByWallet.get(req.params.wallet);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  let analysis = {};
  try { analysis = JSON.parse(agent.ai_analysis || '{}'); } catch(e) {}
  let breakdown = {};
  try { breakdown = JSON.parse(agent.onchain_data || '{}'); } catch(e) {}
  stmts.logQuery.run(agent.id, req.ip);
  res.json({ agent: { name: agent.name, wallet: agent.wallet, reputation_score: agent.reputation_score, onchain_score: agent.onchain_score, vouch_score: agent.vouch_score, status: agent.status, registered_at: agent.registered_at }, analysis, onchain: breakdown });
});

// === AUTO ALERT SYSTEM ===
const { postTweet } = require('./tweeter');
const { generateAlertTweet } = require('./tweet-templates');

async function checkAndAlert(agent, scoring) {
  const anomalies = scoring.breakdown?.anomalies || [];
  if (anomalies.length === 0) return;

  // Only alert on high severity or 2+ flags
  const highSev = anomalies.filter(a => a.severity === 'high' || a.severity === 'critical');
  if (highSev.length === 0 && anomalies.length < 2) return;

  // Check if we already alerted for this agent recently
  const lastAlert = db.prepare("SELECT * FROM alerts WHERE agent_id = ? AND created_at > datetime('now', '-24 hours')").all(agent.id);
  if (lastAlert.length > 0) return;


  const tweet = await generateAlertTweet(agent, scoring);

  try {
    await postTweet(tweet);
    db.prepare("INSERT INTO alerts (agent_id, tweet_text, created_at) VALUES (?, ?, datetime('now'))").run(agent.id, tweet);
    console.log('[Alert] Tweeted about ' + agent.name);
  } catch(e) {
    console.error('[Alert] Tweet failed:', e.message);
  }
}
