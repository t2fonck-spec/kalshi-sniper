'use strict';

/**
 * arb_scanner.js
 * Fetches odds from The Odds API and finds cross-book arbitrage opportunities.
 * Ported from: /home/libri/claude-workspace/arb-finder/arb_finder.py
 */

const axios = require('axios');

const ODDS_API_BASE = 'https://api.the-odds-api.com/v4';

/**
 * Fetch h2h odds for a single sport.
 * Returns [] on HTTP 422 (sport exists but no current games — normal during off-season).
 */
async function fetchOdds(apiKey, sportKey, regions = 'us,uk,eu,au') {
  const params = {
    apiKey,
    regions,
    markets: 'h2h',
    oddsFormat: 'decimal',
  };

  let res;
  try {
    res = await axios.get(`${ODDS_API_BASE}/sports/${sportKey}/odds`, {
      params,
      timeout: 15000,
    });
  } catch (err) {
    if (err.response && err.response.status === 422) return { events: [], quotaRemaining: null };
    throw err;
  }

  const quotaRemaining = res.headers['x-requests-remaining'] || null;
  return { events: res.data, quotaRemaining };
}

/**
 * Find cross-book arbitrage opportunities.
 * For each event, find the best odds per outcome across all bookmakers.
 * If the sum of implied probabilities (1/odds) < 1.0, it's an arb.
 * Generalizes to N outcomes (2-way for basketball/NFL, 3-way for soccer with Draw).
 */
function findArbs(events, minProfitPct) {
  const arbs = [];

  for (const event of events) {
    const best = {}; // outcome name -> { odds, book }

    for (const bookmaker of (event.bookmakers || [])) {
      for (const market of (bookmaker.markets || [])) {
        if (market.key !== 'h2h') continue;
        for (const outcome of market.outcomes) {
          const name = outcome.name;
          const price = parseFloat(outcome.price);
          if (!best[name] || price > best[name].odds) {
            best[name] = { odds: price, book: bookmaker.title };
          }
        }
      }
    }

    const outcomes = Object.keys(best);
    if (outcomes.length < 2) continue;

    const impliedSum = outcomes.reduce((sum, name) => sum + 1.0 / best[name].odds, 0);
    if (impliedSum >= 1.0) continue;

    const profitPct = (1.0 / impliedSum - 1.0) * 100.0;
    if (profitPct < minProfitPct) continue;

    arbs.push({
      event: `${event.away_team} @ ${event.home_team}`,
      sport: event.sport_title,
      sportKey: event.sport_key,
      commence: event.commence_time,
      profitPct,
      impliedSum,
      bets: Object.fromEntries(
        outcomes.map((name) => [name, { odds: best[name].odds, book: best[name].book }])
      ),
    });
  }

  return arbs.sort((a, b) => b.profitPct - a.profitPct);
}

/**
 * Add bet sizing to arb results given a stake.
 * Uses (1/odds) / impliedSum * stake — generalizes to N outcomes.
 */
function addBetSizing(arbs, stake) {
  return arbs.map((arb) => {
    const betsWithSizing = {};
    for (const [name, info] of Object.entries(arb.bets)) {
      const betSize = (1.0 / info.odds) / arb.impliedSum * stake;
      betsWithSizing[name] = { ...info, stake: betSize };
    }
    const guaranteedProfit = stake / arb.impliedSum - stake;
    return { ...arb, bets: betsWithSizing, profitUsd: guaranteedProfit, stake };
  });
}

/**
 * Main entry point. Scans all configured sports and returns arb results.
 *
 * @param {object} opts
 * @param {string} opts.apiKey - The Odds API key
 * @param {string[]} opts.sports - sport keys to scan
 * @param {string} opts.regions - comma-separated region codes
 * @param {number} opts.minProfitPct - minimum profit % threshold
 * @param {number} opts.stake - USD stake for bet sizing
 * @returns {{ arbs: object[], eventsScanned: number, quotaRemaining: string|null }}
 */
async function scanArbs({ apiKey, sports, regions = 'us,uk,eu,au', minProfitPct = 2.0, stake = 100 }) {
  let allEvents = [];
  let quotaRemaining = null;

  for (const sportKey of sports) {
    try {
      const result = await fetchOdds(apiKey, sportKey, regions);
      allEvents = allEvents.concat(result.events);
      if (result.quotaRemaining !== null) quotaRemaining = result.quotaRemaining;
      console.log(`  [Arb] ${sportKey}: ${result.events.length} events`);
    } catch (err) {
      if (err.response && (err.response.status === 401 || err.response.status === 429)) {
        console.error(`  [Arb] ${sportKey}: quota exhausted (${err.response.status})`);
        return { arbs: [], eventsScanned: allEvents.length, quotaRemaining: '0', quotaExhausted: true };
      }
      console.error(`  [Arb] ${sportKey}: ${err.message}`);
    }
  }

  const rawArbs = findArbs(allEvents, minProfitPct);
  const arbs = addBetSizing(rawArbs, stake);

  console.log(`[Arb] Scanned ${allEvents.length} events, found ${arbs.length} arbs`);
  return { arbs, eventsScanned: allEvents.length, quotaRemaining };
}

module.exports = { scanArbs, findArbs, addBetSizing, fetchOdds };
