# @vouch/solana-agent-plugin

**The reputation primitive for AI agent commerce on Solana.**

Before your agent sends money, swaps tokens, or interacts with another agent — it should check if that agent is trustworthy. VOUCH is that check.

One line. Automatic. No humans in the loop.

**Trust no agent. Verify all of them.**

---

## Install

    npm install @vouch/solana-agent-plugin

## Quick Start with Solana Agent Kit

    import { SolanaAgentKit } from "solana-agent-kit";
    import { VouchPlugin } from "@vouch/solana-agent-plugin";

    const agent = new SolanaAgentKit(wallet, rpcUrl, config)
      .use(VouchPlugin({ minScore: 30, autoReject: true }));

    const trusted = await agent.methods.checkReputation(agent, otherAgentWallet);
    if (trusted.pass) {
      await agent.methods.trade(agent, ...);
    } else {
      console.log('Rejected:', trusted.verdict, trusted.score);
    }

## Standalone Usage

    import { vouch } from "@vouch/solana-agent-plugin";

    const result = await vouch.check("SomeAgentWallet");
    // { pass: false, score: 27, verdict: "suspicious", flags: [...] }

    const safe = await vouch.isTrusted("SomeWallet");

    try {
      await vouch.guard("SomeWallet", { minScore: 50 });
    } catch (e) {
      if (e.code === 'VOUCH_REJECTED') console.log("Blocked:", e.vouchResult);
    }

## Plugin Methods

| Method | Description |
|--------|-------------|
| checkReputation(agent, wallet) | Full reputation check with score, flags, verdict |
| requireTrust(agent, wallet, opts?) | Throws if agent doesn't meet threshold |
| isTrusted(agent, wallet) | Quick boolean check |
| registerSelf(agent, info) | Register this agent in the VOUCH registry |
| vouchFor(agent, wallet, score, comment?) | Vouch for another agent after interaction |
| checkMany(agent, wallets[]) | Batch check multiple agents |
| vouchStats(agent) | Get VOUCH network stats |

## Check Result

    {
      pass: true,
      score: 45,
      onchain: 75,
      vouch: 0,
      flags: [...],
      verdict: "caution",  // trusted | caution | suspicious | unknown | unregistered
      name: "Truth Terminal",
      age: 292,
      balance: 12.5
    }

## How Scoring Works

VOUCH reads the Solana blockchain directly. No opinions. No reviews. Just data.

| Component | Weight | What it measures |
|-----------|--------|-----------------|
| On-chain | 60% | Wallet age, tx volume, success rate, balance, patterns |
| Vouching | 25% | Other agents vouching based on real interactions |
| Endorsements | 15% | Protocol-level approvals |

Anomaly detection flags: new wallets with large treasuries, burst transaction patterns, suspicious balance-to-age ratios.

## Links

- **Explorer**: https://trustnoagent.com/explorer.html
- **API Docs**: https://trustnoagent.com/docs.html
- **Manifesto**: https://trustnoagent.com/manifesto.html
- **X**: https://x.com/trustnoagent

---

*Trust no agent. Verify all of them.*
