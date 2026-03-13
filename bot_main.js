'use strict';

/**
 * bot_main.js — Kalshi Arbitrage Bot
 * Scout → Analyst → Sniper + live dashboard (http://localhost:DASHBOARD_PORT)
 */

require('dotenv').config();
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const express = require('express');
const { KalshiClient } = require('./kalshi_client');
const { analyzeMarket, prescreen, sleep } = require('./fair_value_engine');

// --- Config ---
const DRY_RUN           = process.env.DRY_RUN !== 'false';
const MIN_EDGE_PCT       = parseFloat(process.env.MIN_EDGE_PCT      || '8');
const MAX_BET_PCT        = parseFloat(process.env.MAX_BET_PCT       || '15') / 100;
const DAILY_SL_PCT       = parseFloat(process.env.DAILY_STOP_LOSS_PCT || '20') / 100;
const POLL_MS            = parseInt(process.env.POLL_INTERVAL_MS    || '10000', 10);
const PORT               = parseInt(process.env.DASHBOARD_PORT      || '4242', 10);

// --- State ---
const state = {
  running: true,
  dryRun: DRY_RUN,
  startBalance: 0,
  currentBalance: 0,
  dailyPnl: 0,
  dailyPnlPct: 0,
  totalTrades: 0,
  markets: [],
  recentTrades: [],
  lastScanAt: null,
  stopLossHit: false,
  errors: [],
};

const kalshi = new KalshiClient();

// --- Dashboard ---
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/state', (_req, res) => res.json(trimState()));

wss.on('connection', (ws) => ws.send(JSON.stringify({ type: 'state', data: trimState() })));

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((ws) => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function trimState() {
  return { ...state, markets: state.markets.slice(0, 60), recentTrades: state.recentTrades.slice(0, 20) };
}

// --- Risk ---
function checkStopLoss() {
  if (state.dailyPnlPct <= -DAILY_SL_PCT) {
    state.stopLossHit = true;
    state.running = false;
    console.error(`[RISK] Stop-loss hit at ${(state.dailyPnlPct * 100).toFixed(1)}%. Halting.`);
    broadcast('alert', { level: 'critical', message: `Stop-loss triggered at ${(state.dailyPnlPct * 100).toFixed(1)}% daily loss` });
    return true;
  }
  return false;
}

function kellyBet(fairValue, priceFrac, balance) {
  const p = fairValue, q = 1 - p;
  const b = (1 - priceFrac) / priceFrac;
  const kelly = Math.max(0, (b * p - q) / b);
  const halfKelly = kelly * 0.5;
  return Math.min(halfKelly * balance, balance * MAX_BET_PCT);
}

// Curated series to scan — these have real two-sided quotes unlike the KXMVE junk
// that floods the default /markets endpoint
const SCAN_SERIES = [
  // Crypto
  'KXBTC', 'KXETH',
  // Macro / Economic
  'KXFED', 'KXFEDDECISION', 'KXCPI', 'KXINFL', 'KXGDP', 'KXUNRATE', 'KXPCE',
  // Equities / Commodities
  'KXSPY', 'KXQQQ', 'KXGOLD', 'KXSILVER', 'KXOIL', 'KXETF',
  // Sports (daily resolution)
  'KXNBA', 'KXNFL', 'KXMLB', 'KXNHL', 'KXMMA', 'KXSOCCER', 'KXTENNIS',
  // Politics / World events
  'KXHOUSERACE', 'KXELECTION', 'KXTRUMP', 'KXPOLITICS', 'KXFEDDECISION',
  // Other popular
  'KXEARTHQUAKECALIFORNIA', 'KXWEATHER', 'KXNEWPOPE', 'KXGOVTCUTS',
];

// --- Scout ---
async function scout() {
  console.log(`[Scout] Scanning ${SCAN_SERIES.length} series...`);
  const markets = await kalshi.fetchMarketsBySeries(SCAN_SERIES, { delayMs: 200 });
  console.log(`[Scout] Fetched ${markets.length} markets total`);

  const viable = markets
    .filter((m) => {
      if (m.market_type !== 'binary') return false;
      const bid = m.yes_bid || 0;
      const ask = m.yes_ask || 0;
      if (bid <= 0 || ask <= 0) return false;
      const spread = ask - bid;
      const mid = (bid + ask) / 2;
      return mid > 1 && mid < 99 && spread <= 25;
    })
    .map((m) => ({ market: m, ob: kalshi.marketToOrderBook(m) }));

  console.log(`[Scout] ${viable.length} viable (binary, priced, tight spread)`);
  return viable;
}

const MAX_ANALYZE_PER_CYCLE = parseInt(process.env.MAX_ANALYZE || '10', 10);

// --- Analyst ---
async function analyze(viable) {
  const analyzed = [];

  // Pre-screen: sort by 24h volume descending, take top N for LLM analysis
  // This avoids burning Claude API budget on illiquid tail markets
  const prescreened = prescreen(viable.map(v => v.market), viable.map(v => v.ob), {
    minLiquidity: 0,  // use volume sort instead
    maxSpread: 20,
  });

  const toAnalyze = viable
    .filter(({ ob }) => ob.spread <= 20)
    .sort((a, b) => (b.market.volume_24h || 0) - (a.market.volume_24h || 0))
    .slice(0, MAX_ANALYZE_PER_CYCLE);

  console.log(`[Analyst] Analyzing top ${toAnalyze.length} markets by 24h volume (${viable.length} viable total)`);

  for (const { market, ob } of toAnalyze) {
    try {
      const analysis = await analyzeMarket(market, ob);
      const entry = {
        ticker: market.ticker,
        title: analysis.title,
        kalshiPrice: analysis.midFrac,
        fairValue: analysis.fairValue,
        midCents: analysis.midCents,
        fairValueCents: analysis.fairValueCents,
        edge: analysis.edge,
        edgePct: analysis.edgePct,
        confidence: analysis.confidence,
        direction: analysis.direction,
        reasoning: analysis.reasoning,
        liquidity: ob.liquidityUSD,
        updatedAt: Date.now(),
      };

      analyzed.push(entry);
      const idx = state.markets.findIndex((m) => m.ticker === market.ticker);
      if (idx >= 0) state.markets[idx] = entry;
      else state.markets.unshift(entry);
      broadcast('market_update', entry);

      await sleep(500);
    } catch (err) {
      console.error(`[Analyst] ${market.ticker}: ${err.message}`);
    }
  }

  state.markets.sort((a, b) => b.edgePct - a.edgePct);
  return analyzed;
}

// --- Sniper ---
async function snipe(entry) {
  if (state.stopLossHit || entry.edgePct < MIN_EDGE_PCT || entry.confidence === 'low') return;

  const isBuyYes = entry.direction === 'BUY_YES';
  const side = isBuyYes ? 'yes' : 'no';
  const priceCents = isBuyYes ? entry.midCents : 100 - entry.midCents;
  const priceFrac = priceCents / 100;

  const betSize = kellyBet(entry.fairValue, priceFrac, state.currentBalance);
  if (betSize < 5) {
    console.log(`[Sniper] Bet $${betSize.toFixed(2)} too small for "${entry.title}", skipping`);
    return;
  }

  console.log(`\n[SNIPER] *** OPPORTUNITY ***`);
  console.log(`  Market : ${entry.title}`);
  console.log(`  Action : BUY ${side.toUpperCase()} @ ${priceCents.toFixed(1)}¢`);
  console.log(`  Fair   : ${(entry.fairValue * 100).toFixed(1)}¢`);
  console.log(`  Edge   : ${entry.edgePct.toFixed(1)}%`);
  console.log(`  Size   : $${betSize.toFixed(2)}`);
  console.log(`  Conf   : ${entry.confidence}`);

  try {
    const order = await kalshi.placeOrder(entry.ticker, side, Math.round(priceCents), betSize);

    const trade = {
      id: order.order_id || order.id,
      title: entry.title,
      side: `BUY ${side.toUpperCase()}`,
      price: priceFrac,
      fairValue: entry.fairValue,
      edgePct: entry.edgePct,
      sizeUSDC: betSize,
      status: order.status || 'submitted',
      ts: Date.now(),
      dryRun: DRY_RUN,
    };

    state.recentTrades.unshift(trade);
    state.totalTrades++;

    state.currentBalance = DRY_RUN
      ? Math.max(0, state.currentBalance - betSize)
      : await kalshi.getBalance();
    state.dailyPnl = state.currentBalance - state.startBalance;
    state.dailyPnlPct = state.startBalance > 0 ? state.dailyPnl / state.startBalance : 0;

    broadcast('trade', trade);
    checkStopLoss();
  } catch (err) {
    const msg = `[Sniper] Order failed on ${entry.ticker}: ${err.message}`;
    console.error(msg);
    state.errors.unshift({ msg, ts: Date.now() });
    broadcast('error', { message: msg });
  }
}

// --- Main Loop ---
async function main() {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Kalshi Arb Bot`);
  console.log(`  Mode: ${DRY_RUN ? '🔵 DRY RUN' : '🔴 LIVE TRADING'}`);
  console.log(`  Min Edge: ${MIN_EDGE_PCT}% | Max Bet: ${(MAX_BET_PCT * 100).toFixed(0)}% | Stop Loss: ${(DAILY_SL_PCT * 100).toFixed(0)}%`);
  console.log(`${'═'.repeat(60)}\n`);

  await kalshi.login();

  state.startBalance = await kalshi.getBalance();
  state.currentBalance = state.startBalance;
  console.log(`[Init] Balance: $${state.startBalance.toFixed(2)}`);

  while (state.running) {
    try {
      state.lastScanAt = Date.now();

      const viable = await scout();
      const analyzed = await analyze(viable);

      const opps = analyzed
        .filter((e) => e.edgePct >= MIN_EDGE_PCT && e.confidence !== 'low')
        .sort((a, b) => b.edgePct - a.edgePct)
        .slice(0, 3);

      for (const opp of opps) {
        await snipe(opp);
        if (state.stopLossHit) break;
      }

      broadcast('state', trimState());
      await sleep(POLL_MS);
    } catch (err) {
      const msg = `[Loop] ${err.message}`;
      console.error(msg);
      state.errors.unshift({ msg, ts: Date.now() });
      await sleep(20_000);
    }
  }
}

server.listen(PORT, () => console.log(`[Dashboard] http://localhost:${PORT}`));

main().catch((err) => { console.error('[Fatal]', err); process.exit(1); });

process.on('SIGINT', () => { state.running = false; process.exit(0); });
