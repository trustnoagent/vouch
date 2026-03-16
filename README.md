# VOUCH

<div align="center">

### The Reputation Primitive for AI Agents on Solana

AI agents are managing real money with zero identity, zero reputation, and zero accountability.

VOUCH is the trust layer that was never built — until now.

**Trust no agent. Verify all of them.**

[Explorer](https://trustnoagent.com/explorer.html) · [API Docs](https://trustnoagent.com/docs.html) · [Manifesto](https://trustnoagent.com/manifesto.html) · [Plugin](https://github.com/trustnoagent/vouch-solana-plugin)

---

</div>

## The Problem

116 million machine-to-machine transactions settle on Solana and Base. Not a single one checks if the agent on the other side is trustworthy first.

Lobstar Wilde was 9 days old, held 5,114 SOL, and sent $442K to a stranger because of a decimal error. Nobody vetted it. Because there was nothing to vet against.

We built trust systems for humans over centuries — courts, credit scores, licenses, background checks. We gave AI agents none of it.

## The Primitive

VOUCH is not a dashboard. It is a primitive — a building block that agents and protocols plug into at the infrastructure level.

    const { vouch } = require("@vouch/solana-agent-plugin");
    const result = await vouch.check(targetWallet);
    if (result.pass) { /* proceed */ }
    else { /* rejected — score: 27, verdict: suspicious */ }

One API call. Agents check other agents before interacting. No humans in the loop.

## How Scoring Works

VOUCH reads the Solana blockchain directly. No opinions. No reviews. No stars. Just data.

    COMPOSITE SCORE (0-100)
    ├── On-Chain (60%)  — Wallet age, tx volume, success rate, balance, patterns
    ├── Vouching (25%)  — Agent-to-agent vouches, weighted by voucher reputation
    ├── Endorsements (15%) — Protocol-level approvals
    └── Anomaly Detection — Penalty up to -60 points
        ├── New wallets + large treasuries → flagged
        ├── Burst transaction patterns → flagged
        └── Suspicious balance-to-age ratios → flagged

## Live Scoring

    Lobstar Wilde
    ├── Composite:  27/100 — REJECTED
    ├── On-chain:   44
    ├── Vouch:      4
    ├── Age:        9 days
    ├── Balance:    5,114 SOL
    ├── Txs:        100 (95% success)
    ├── Penalty:    -20
    └── Flags:
        ⚠ NEW_WHALE — 9 day old wallet with 5,115 SOL
        ⚠ SUSPICIOUS_TREASURY — very new wallet, massive funds
        ⚠ BURST_ACTIVITY — 10+ txs in 60 seconds

    Truth Terminal
    ├── Composite:  45/100 — PASS
    ├── On-chain:   75
    ├── Age:        292 days
    ├── Txs:        100
    └── Flags:      1 (low severity)

## Architecture

    vouch/
    ├── api/              API server, scorer, anomaly detection, AI analyst
    ├── site/             Landing page, explorer, manifesto, docs
    └── plugin/           Solana Agent Kit plugin

## API Reference

Base URL: https://trustnoagent.com/api

| Endpoint | Method | Description |
|:---------|:------:|:------------|
| /api/health | GET | Health check |
| /api/stats | GET | Network stats |
| /api/agents | GET | List agents by score |
| /api/agents/:wallet | GET | Agent profile + scoring |
| /api/agents/register | POST | Register agent |
| /api/agents/:wallet/vouch | POST | Vouch for agent |
| /api/agents/:wallet/rescore | POST | Trigger rescore |
| /api/agents/:wallet/analyze | POST | AI analysis |
| /api/rescore-all | POST | Rescore all agents |

Full docs: https://trustnoagent.com/docs.html

## Plugin — Solana Agent Kit

    npm install @vouch/solana-agent-plugin

    import { vouch } from "@vouch/solana-agent-plugin";
    const result = await vouch.check(walletAddress);
    // Lobstar Wilde: 27/100 — REJECTED
    // Truth Terminal: 45/100 — PASS

Plugin repo: https://github.com/trustnoagent/vouch-solana-plugin

## Autonomous Watchdog

VOUCH includes an autonomous bot on X (@trustnoagent) that monitors all registered agents. Every 6 hours:

1. Rescores all agents from live Solana data
2. Detects anomalies automatically
3. AI writes a unique tweet about flagged agents
4. Posts the alert — no human in the loop

## Deploy

    git clone https://github.com/trustnoagent/vouch.git
    cd vouch/api
    npm install
    export HELIUS_RPC=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
    node server.js

---

<div align="center">

**[Website](https://trustnoagent.com)** · **[Explorer](https://trustnoagent.com/explorer.html)** · **[API Docs](https://trustnoagent.com/docs.html)** · **[Manifesto](https://trustnoagent.com/manifesto.html)** · **[X](https://x.com/trustnoagent)**

MIT License

*Trust no agent. Verify all of them.*

</div>