'use strict';

/**
 * fair_value_engine.js
 * Uses Claude (claude-opus-4-6) with adaptive thinking + web search to estimate
 * the true probability of a Kalshi event and flag mispriced markets.
 *
 * Kalshi prices are in cents (0–99). Fair value returned as fraction [0,1].
 * Edge = |fairValue - midpointFrac| as a percentage.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });

const CACHE_TTL_MS = 90_000; // 90s — Kalshi markets move slower than crypto
const analysisCache = new Map();

/**
 * Analyze a Kalshi market and return fair value + edge.
 *
 * @param {object} market - Kalshi market object
 * @param {object} orderBook - from KalshiClient.fetchOrderBook()
 * @returns {object} analysis result
 */
async function analyzeMarket(market, orderBook) {
  const cacheKey = market.ticker;
  const cached = analysisCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached.result;

  const title = market.title || market.ticker;
  const subtitle = market.subtitle || '';
  const category = market.category || '';
  const closeTime = market.close_time || 'unknown';
  const midCents = orderBook.midpoint;
  const midFrac = orderBook.midpointFrac;
  const spread = orderBook.spread;
  const liquidity = orderBook.liquidityUSD;

  const systemPrompt = `You are a quantitative analyst specializing in US prediction markets (Kalshi).
Estimate the TRUE probability of binary events, then compare to current market prices to find edges.
Be calibrated — Kalshi markets are CFTC-regulated and often efficient, especially for political/macro events.
Output ONLY valid JSON. No markdown. No extra text.`;

  const userPrompt = `Analyze this Kalshi prediction market:

MARKET: ${title}
SUBTITLE: ${subtitle}
CATEGORY: ${category}
CLOSES: ${closeTime}
CURRENT PRICE: ${midCents.toFixed(1)}¢ YES (= ${(midFrac * 100).toFixed(1)}% probability)
BID-ASK SPREAD: ${spread.toFixed(1)}¢
LIQUIDITY: ~$${liquidity.toFixed(0)}

Instructions:
1. Search for recent relevant news, data, or events that affect this probability
2. Consider base rates, polling data, official data releases, or comparable markets
3. Estimate the true probability with a confidence interval

Return this exact JSON:
{
  "fairValue": <0.0–1.0>,
  "confidenceLow": <80% CI lower bound>,
  "confidenceHigh": <80% CI upper bound>,
  "confidence": <"low"|"medium"|"high">,
  "reasoning": "<2-3 sentences>",
  "keyFactors": ["<factor>", "<factor>", "<factor>"],
  "comparableMarkets": "<any comparable Kalshi/Polymarket/PredictIt odds you know>"
}`;

  let result;
  try {
    const stream = await client.messages.stream({
      model: 'claude-opus-4-6',
      max_tokens: 4096,
      thinking: { type: 'enabled', budget_tokens: 2000 },
      tools: [{ type: 'web_search_20260209', name: 'web_search' }],
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const response = await stream.finalMessage();
    // Use the LAST text block — earlier blocks are often tool-use narration
    const textBlocks = response.content.filter((b) => b.type === 'text');
    const rawText = (textBlocks[textBlocks.length - 1]?.text || '{}').trim();
    // Extract JSON object robustly — strip markdown fences and any surrounding prose
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    const jsonText = jsonMatch ? jsonMatch[0] : '{}';
    const parsed = JSON.parse(jsonText);

    const fairValue = Math.max(0.01, Math.min(0.99, parsed.fairValue || 0.5));
    const edge = fairValue - midFrac;
    const edgePct = Math.abs(edge) * 100;

    result = {
      ticker: cacheKey,
      title,
      midCents,
      midFrac,
      fairValue,
      fairValueCents: fairValue * 100,
      confidenceLow: parsed.confidenceLow ?? fairValue - 0.1,
      confidenceHigh: parsed.confidenceHigh ?? fairValue + 0.1,
      confidence: parsed.confidence || 'low',
      edge,          // positive = YES is cheap, negative = NO is cheap
      edgePct,
      direction: edge > 0 ? 'BUY_YES' : 'BUY_NO',
      reasoning: parsed.reasoning || '',
      keyFactors: parsed.keyFactors || [],
      comparableMarkets: parsed.comparableMarkets || '',
      analyzedAt: Date.now(),
    };
  } catch (err) {
    console.error(`[FairValue] Error on "${title}": ${err.message}`);
    result = {
      ticker: cacheKey,
      title,
      midCents,
      midFrac,
      fairValue: midFrac,
      fairValueCents: midCents,
      confidenceLow: midFrac - 0.15,
      confidenceHigh: midFrac + 0.15,
      confidence: 'low',
      edge: 0,
      edgePct: 0,
      direction: 'NONE',
      reasoning: `Analysis failed: ${err.message}`,
      keyFactors: [],
      comparableMarkets: '',
      analyzedAt: Date.now(),
      error: true,
    };
  }

  analysisCache.set(cacheKey, { ts: Date.now(), result });
  return result;
}

/**
 * Pre-screen markets using only order book data — no LLM cost.
 * Returns markets worth full analysis.
 */
function prescreen(markets, orderBooks, { minLiquidity = 200, maxSpread = 15 } = {}) {
  return markets
    .map((m, i) => ({ market: m, ob: orderBooks[i] }))
    .filter(({ ob }) => ob && ob.liquidityUSD >= minLiquidity && ob.spread <= maxSpread);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

module.exports = { analyzeMarket, prescreen, sleep };
