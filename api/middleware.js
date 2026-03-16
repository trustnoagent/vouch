/**
 * VOUCH API Access Control
 * 
 * Free tier: 10 queries/day per IP
 * Paid tier: Unlimited queries with $VOUCH credits
 * 
 * When token launches:
 * - Users deposit $VOUCH to get credits
 * - Each query costs credits
 * - No credits = free tier limits apply
 */

// In-memory rate limiter for free tier
const rateLimits = new Map();

const FREE_DAILY_LIMIT = 10;
const CREDIT_COST_PER_QUERY = 1;

function cleanExpired() {
  const now = Date.now();
  for (const [key, val] of rateLimits) {
    if (now - val.start > 86400000) rateLimits.delete(key);
  }
}

// Run cleanup every hour
setInterval(cleanExpired, 3600000);

function createAccessControl(db) {
  // Create credits table
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_credits (
      wallet TEXT PRIMARY KEY,
      credits REAL NOT NULL DEFAULT 0,
      total_deposited REAL NOT NULL DEFAULT 0,
      total_spent REAL NOT NULL DEFAULT 0,
      api_key TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_used TEXT
    );

    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      wallet TEXT,
      endpoint TEXT,
      ip TEXT,
      tier TEXT NOT NULL DEFAULT 'free',
      credit_cost REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const stmts = {
    getByKey: db.prepare('SELECT * FROM api_credits WHERE api_key = ?'),
    getByWallet: db.prepare('SELECT * FROM api_credits WHERE wallet = ?'),
    deductCredit: db.prepare('UPDATE api_credits SET credits = credits - ?, total_spent = total_spent + ?, last_used = datetime(?) WHERE api_key = ?'),
    addCredits: db.prepare('UPDATE api_credits SET credits = credits + ?, total_deposited = total_deposited + ? WHERE wallet = ?'),
    createAccount: db.prepare('INSERT INTO api_credits (wallet, api_key, credits) VALUES (?, ?, ?)'),
    logUsage: db.prepare('INSERT INTO api_usage (wallet, endpoint, ip, tier, credit_cost) VALUES (?, ?, ?, ?, ?)'),
    dailyUsage: db.prepare("SELECT COUNT(*) as count FROM api_usage WHERE ip = ? AND created_at > datetime('now', '-1 day') AND tier = 'free'"),
  };

  /**
   * Middleware: Check API access
   * 
   * Headers:
   *   x-vouch-key: API key (for paid tier)
   * 
   * No key = free tier (rate limited)
   */
  function accessControl(req, res, next) {
    const apiKey = req.headers['x-vouch-key'];
    const ip = req.ip || req.connection.remoteAddress;
    const endpoint = req.path;

    // Skip for health and stats (always free)
    if (endpoint === '/api/health' || endpoint === '/api/stats') {
      return next();
    }

    // Paid tier
    if (apiKey) {
      const account = stmts.getByKey.get(apiKey);
      
      if (!account) {
        return res.status(401).json({ 
          error: 'invalid_api_key',
          message: 'Invalid API key. Get one at trustnoagent.com/docs.html'
        });
      }

      if (account.credits < CREDIT_COST_PER_QUERY) {
        return res.status(402).json({
          error: 'credits_depleted',
          message: 'No credits remaining. Deposit $VOUCH to add credits.',
          wallet: account.wallet,
          credits: account.credits
        });
      }

      // Deduct credit
      const now = new Date().toISOString();
      stmts.deductCredit.run(CREDIT_COST_PER_QUERY, CREDIT_COST_PER_QUERY, now, apiKey);
      stmts.logUsage.run(account.wallet, endpoint, ip, 'paid', CREDIT_COST_PER_QUERY);

      req.vouchTier = 'paid';
      req.vouchWallet = account.wallet;
      req.vouchCredits = account.credits - CREDIT_COST_PER_QUERY;
      return next();
    }

    // Free tier — rate limited
    const { count } = stmts.dailyUsage.get(ip);
    
    if (count >= FREE_DAILY_LIMIT) {
      return res.status(429).json({
        error: 'rate_limited',
        message: `Free tier limit reached (${FREE_DAILY_LIMIT}/day). Get an API key with $VOUCH credits for unlimited access.`,
        limit: FREE_DAILY_LIMIT,
        used: count,
        upgrade: 'https://trustnoagent.com/docs.html'
      });
    }

    stmts.logUsage.run(null, endpoint, ip, 'free', 0);
    req.vouchTier = 'free';
    return next();
  }

  /**
   * Generate API key for a wallet
   */
  function generateApiKey(wallet) {
    const existing = stmts.getByWallet.get(wallet);
    if (existing) return { wallet, apiKey: existing.api_key, credits: existing.credits };

    const crypto = require('crypto');
    const apiKey = 'vch_' + crypto.randomBytes(24).toString('hex');
    stmts.createAccount.run(wallet, apiKey, 0);
    return { wallet, apiKey, credits: 0 };
  }

  /**
   * Add credits to a wallet account
   * Called after verifying $VOUCH deposit on-chain
   */
  function addCredits(wallet, amount) {
    const account = stmts.getByWallet.get(wallet);
    if (!account) {
      generateApiKey(wallet);
    }
    stmts.addCredits.run(amount, amount, wallet);
    return stmts.getByWallet.get(wallet);
  }

  /**
   * Get usage stats
   */
  function getUsageStats() {
    const total = db.prepare('SELECT COUNT(*) as count FROM api_usage').get().count;
    const paid = db.prepare("SELECT COUNT(*) as count FROM api_usage WHERE tier = 'paid'").get().count;
    const free = db.prepare("SELECT COUNT(*) as count FROM api_usage WHERE tier = 'free'").get().count;
    const totalCreditsSpent = db.prepare('SELECT SUM(total_spent) as sum FROM api_credits').get().sum || 0;
    const activeKeys = db.prepare('SELECT COUNT(*) as count FROM api_credits WHERE credits > 0').get().count;
    return { total, paid, free, totalCreditsSpent, activeKeys };
  }

  return { accessControl, generateApiKey, addCredits, getUsageStats };
}

module.exports = { createAccessControl };
