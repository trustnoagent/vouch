/**
 * @vouch/solana-agent-plugin
 * 
 * The reputation primitive for AI agent commerce on Solana.
 * Agents check other agents before interacting. No humans in the loop.
 * 
 * Usage:
 *   import { VouchPlugin } from '@vouch/solana-agent-plugin';
 *   agent.use(VouchPlugin({ minScore: 30, autoReject: true }));
 * 
 * Or standalone:
 *   import { vouch } from '@vouch/solana-agent-plugin';
 *   const trusted = await vouch.check('walletAddress');
 *   if (!trusted.pass) reject();
 * 
 * Trust no agent. Verify all of them.
 * https://trustnoagent.com
 */

const https = require('https');

const VOUCH_API = 'https://trustnoagent.com/api';

// === CORE API CLIENT ===

class VouchClient {
  constructor(options = {}) {
    this.apiUrl = options.apiUrl || VOUCH_API;
    this.minScore = options.minScore ?? 30;
    this.autoReject = options.autoReject ?? false;
    this.cache = new Map();
    this.cacheTTL = options.cacheTTL ?? 300000; // 5 min default
    this.onCheck = options.onCheck || null; // callback after each check
    this.onReject = options.onReject || null; // callback on rejection
  }

  /**
   * Check an agent's reputation before interacting.
   * Returns { pass, score, flags, verdict, wallet, cached }
   */
  async check(wallet) {
    if (!wallet || typeof wallet !== 'string') {
      return { pass: false, score: 0, flags: [], verdict: 'invalid_wallet', wallet, cached: false };
    }

    // Check cache first
    const cached = this.cache.get(wallet);
    if (cached && Date.now() - cached.time < this.cacheTTL) {
      return { ...cached.result, cached: true };
    }

    try {
      const data = await this._fetch(`${this.apiUrl}/agents/${wallet}`);
      
      const score = data.agent?.reputation_score ?? 0;
      const onchain = data.scoring?.onchain ?? 0;
      const vouchScore = data.scoring?.vouch ?? 0;
      const anomalies = data.scoring?.breakdown?.anomalies || [];
      const flags = anomalies.map(a => ({ type: a.type, detail: a.detail, severity: a.severity }));
      
      let verdict;
      if (score >= 60) verdict = 'trusted';
      else if (score >= 30) verdict = 'caution';
      else if (score > 0) verdict = 'suspicious';
      else verdict = 'unknown';

      const pass = score >= this.minScore;
      
      const result = {
        pass,
        score,
        onchain,
        vouch: vouchScore,
        flags,
        flagCount: flags.length,
        verdict,
        wallet,
        name: data.agent?.name || 'Unknown',
        age: data.scoring?.breakdown?.age?.days ?? null,
        txCount: data.scoring?.breakdown?.activity?.totalTxs ?? null,
        balance: data.scoring?.breakdown?.balance?.sol ?? null,
        lastScored: data.scoring?.lastScored || null,
        cached: false
      };

      // Cache result
      this.cache.set(wallet, { result, time: Date.now() });

      // Callbacks
      if (this.onCheck) this.onCheck(result);
      if (!pass && this.onReject) this.onReject(result);

      return result;

    } catch (e) {
      // Agent not in registry
      return {
        pass: false,
        score: 0,
        flags: [],
        flagCount: 0,
        verdict: 'unregistered',
        wallet,
        name: null,
        cached: false,
        error: e.message
      };
    }
  }

  /**
   * Quick boolean check — is this agent trusted?
   */
  async isTrusted(wallet) {
    const result = await this.check(wallet);
    return result.pass;
  }

  /**
   * Guard function — throws if agent doesn't meet threshold.
   * Use before any agent-to-agent transaction.
   */
  async guard(wallet, options = {}) {
    const minScore = options.minScore ?? this.minScore;
    const result = await this.check(wallet);

    if (!result.pass || result.score < minScore) {
      const error = new Error(
        `VOUCH: Agent ${wallet.slice(0,8)}... rejected. ` +
        `Score: ${result.score}/${minScore} required. ` +
        `Verdict: ${result.verdict}. ` +
        `Flags: ${result.flagCount}.`
      );
      error.code = 'VOUCH_REJECTED';
      error.vouchResult = result;
      throw error;
    }

    return result;
  }

  /**
   * Register this agent in the VOUCH registry.
   */
  async register(wallet, name, description = '', capabilities = '', website = '') {
    try {
      const data = await this._fetch(`${this.apiUrl}/agents/register`, {
        method: 'POST',
        body: { wallet, name, description, capabilities, website }
      });
      return { success: true, agent: data.agent };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Vouch for another agent after successful interaction.
   */
  async vouchFor(agentWallet, myWallet, score = 3, comment = '') {
    try {
      const data = await this._fetch(`${this.apiUrl}/agents/${agentWallet}/vouch`, {
        method: 'POST',
        body: { voucher_wallet: myWallet, score, comment }
      });
      return { success: true, newScore: data.agent?.reputation_score };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * Get network stats.
   */
  async stats() {
    return this._fetch(`${this.apiUrl}/stats`);
  }

  /**
   * Batch check multiple wallets.
   */
  async checkMany(wallets) {
    const results = await Promise.all(wallets.map(w => this.check(w)));
    return {
      results,
      trusted: results.filter(r => r.pass),
      rejected: results.filter(r => !r.pass),
      summary: {
        total: wallets.length,
        passed: results.filter(r => r.pass).length,
        failed: results.filter(r => !r.pass).length
      }
    };
  }

  // Internal fetch helper
  _fetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(url);
      const body = options.body ? JSON.stringify(options.body) : null;

      const req = https.request({
        hostname: parsedUrl.hostname,
        path: parsedUrl.pathname + parsedUrl.search,
        method: options.method || 'GET',
        headers: {
          ...(body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}),
          'User-Agent': 'vouch-plugin/0.1.0'
        },
        timeout: 10000
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (res.statusCode >= 400) reject(new Error(json.error || 'Request failed'));
            else resolve(json);
          } catch (e) { reject(e); }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      if (body) req.write(body);
      req.end();
    });
  }
}


// === SOLANA AGENT KIT PLUGIN ===

function VouchPlugin(options = {}) {
  const client = new VouchClient(options);

  return {
    name: 'vouch',
    description: 'VOUCH reputation primitive — trust verification for agent-to-agent commerce',

    // Expose client methods on the agent
    methods: {
      /**
       * Check an agent's reputation before interacting.
       * @param {SolanaAgentKit} agent - The agent instance
       * @param {string} wallet - Wallet address to check
       * @returns {Promise<object>} Reputation result
       */
      checkReputation: async (agent, wallet) => {
        return client.check(wallet);
      },

      /**
       * Guard — throws if target agent doesn't meet trust threshold.
       * Use before any transfer, swap, or interaction.
       * @param {SolanaAgentKit} agent - The agent instance
       * @param {string} wallet - Wallet address to verify
       * @param {object} options - { minScore }
       */
      requireTrust: async (agent, wallet, opts = {}) => {
        return client.guard(wallet, opts);
      },

      /**
       * Quick check — returns true/false.
       * @param {SolanaAgentKit} agent - The agent instance
       * @param {string} wallet - Wallet address to check
       */
      isTrusted: async (agent, wallet) => {
        return client.isTrusted(wallet);
      },

      /**
       * Register this agent in the VOUCH registry.
       * @param {SolanaAgentKit} agent - The agent instance
       * @param {object} info - { name, description, capabilities, website }
       */
      registerSelf: async (agent, info = {}) => {
        const wallet = agent.wallet?.publicKey?.toString() || agent.wallet_address;
        return client.register(
          wallet,
          info.name || 'Unnamed Agent',
          info.description || '',
          info.capabilities || '',
          info.website || ''
        );
      },

      /**
       * Vouch for another agent after successful interaction.
       * @param {SolanaAgentKit} agent - The agent instance
       * @param {string} targetWallet - Agent to vouch for
       * @param {number} score - 1 to 5
       * @param {string} comment - Optional
       */
      vouchFor: async (agent, targetWallet, score = 3, comment = '') => {
        const myWallet = agent.wallet?.publicKey?.toString() || agent.wallet_address;
        return client.vouchFor(targetWallet, myWallet, score, comment);
      },

      /**
       * Batch check multiple agents.
       * @param {SolanaAgentKit} agent - The agent instance
       * @param {string[]} wallets - Array of wallet addresses
       */
      checkMany: async (agent, wallets) => {
        return client.checkMany(wallets);
      },

      /**
       * Get VOUCH network stats.
       * @param {SolanaAgentKit} agent - The agent instance
       */
      vouchStats: async (agent) => {
        return client.stats();
      }
    }
  };
}


// === MIDDLEWARE / INTERCEPTOR ===

/**
 * Wraps any agent action with automatic reputation checking.
 * If the target wallet doesn't meet the threshold, the action is blocked.
 * 
 * Usage:
 *   const safeTrade = withVouchGuard(originalTradeFunction, vouchClient);
 *   await safeTrade(agent, targetWallet, amount);
 */
function withVouchGuard(actionFn, client, options = {}) {
  const walletArgIndex = options.walletArgIndex ?? 1; // which arg is the wallet

  return async function (...args) {
    const wallet = args[walletArgIndex];
    
    if (wallet && typeof wallet === 'string' && wallet.length >= 32) {
      const result = await client.check(wallet);
      
      if (!result.pass) {
        console.warn(
          `[VOUCH] Blocked interaction with ${wallet.slice(0,8)}... ` +
          `Score: ${result.score}. Verdict: ${result.verdict}. ` +
          `Flags: ${result.flags.map(f => f.type).join(', ') || 'none'}`
        );
        
        const error = new Error(`VOUCH: Interaction blocked. Agent ${wallet.slice(0,8)}... scored ${result.score}/${client.minScore} required.`);
        error.code = 'VOUCH_BLOCKED';
        error.vouchResult = result;
        throw error;
      }

      console.log(`[VOUCH] Approved interaction with ${wallet.slice(0,8)}... Score: ${result.score}. Verdict: ${result.verdict}`);
    }

    return actionFn(...args);
  };
}


// === EXPORTS ===

// Standalone client
const vouch = new VouchClient();

module.exports = {
  VouchPlugin,       // Solana Agent Kit plugin
  VouchClient,       // Standalone client class
  withVouchGuard,    // Action wrapper/middleware
  vouch              // Default client instance
};

