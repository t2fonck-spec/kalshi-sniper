'use strict';

/**
 * kalshi_client.js
 * Kalshi CLOB API client (CFTC-regulated, US legal).
 * Docs: https://trading-api.kalshi.com/trade-api/v2/openapi.json
 *
 * Kalshi prices are in cents (0–99). Each contract pays $1 if YES resolves.
 * You can buy YES or NO directly — no need to derive NO from YES price.
 */

require('dotenv').config();
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

// Mimic a real browser to avoid CloudFront WAF blocks
const HEADERS_BASE = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json',
  'Accept-Language': 'en-US,en;q=0.9',
};

class KalshiClient {
  constructor() {
    this.email = process.env.KALSHI_EMAIL;
    this.password = process.env.KALSHI_PASSWORD;
    this.apiKey = process.env.KALSHI_API_KEY;
    this.privateKeyPath = process.env.KALSHI_PRIVATE_KEY_PATH || './kalshi_key.pem';
    this.dryRun = process.env.DRY_RUN !== 'false';
    this.minLiquidity = parseFloat(process.env.MIN_LIQUIDITY_USD || '500');
    this._token = null;
    this._memberId = null;
    this._authenticated = false;
  }

  // --- Auth ---

  /**
   * Login with email/password. If no credentials set, runs in read-only mode
   * (market scanning only — no order placement).
   */
  async login() {
    if (this.apiKey) {
      console.log('[Kalshi] Using API key auth');
      this._useKeyAuth = true;
      this._authenticated = true;
      return;
    }

    if (!this.email || !this.password) {
      console.log('[Kalshi] No credentials set — running in READ-ONLY mode (market scanning only)');
      return;
    }

    const res = await axios.post(`${BASE}/login`,
      { email: this.email, password: this.password },
      { headers: { ...HEADERS_BASE, 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    this._token = res.data.token;
    this._memberId = res.data.member_id;
    this._authenticated = true;
    console.log(`[Kalshi] Logged in as member ${this._memberId}`);
  }

  _authHeaders(method = 'GET', path = '', body = '') {
    if (this._useKeyAuth && this.apiKey) {
      // PKCS#8 RSA signature auth
      // PKCS#8 RSA signature auth
      const ts = Date.now().toString();
      const nonce = crypto.randomBytes(8).toString('hex');
      const msgParts = [ts, nonce, method.toUpperCase(), path, body];
      const msg = msgParts.join('');

      let signature = '';
      try {
        const pem = fs.readFileSync(this.privateKeyPath, 'utf8');
        const sign = crypto.createSign('SHA256');
        sign.update(msg);
        signature = sign.sign(pem, 'base64');
      } catch {
        // key file missing — fall back to no-sig (will 401 on real endpoints)
      }

      return {
        'KALSHI-ACCESS-KEY': this.apiKey,
        'KALSHI-ACCESS-TIMESTAMP': ts,
        'KALSHI-ACCESS-NONCE': nonce,
        'KALSHI-ACCESS-SIGNATURE': signature,
        'Content-Type': 'application/json',
      };
    }

    // Session token auth
    return {
      Authorization: `Bearer ${this._token}`,
      'Content-Type': 'application/json',
    };
  }

  async _get(path, params = {}) {
    const headers = { ...HEADERS_BASE, ...this._authHeaders('GET', path) };
    const res = await axios.get(`${BASE}${path}`, { params, headers, timeout: 10000 });
    return res.data;
  }

  async _post(path, data = {}) {
    const body = JSON.stringify(data);
    const headers = { ...HEADERS_BASE, 'Content-Type': 'application/json', ...this._authHeaders('POST', path, body) };
    const res = await axios.post(`${BASE}${path}`, data, { headers, timeout: 15000 });
    return res.data;
  }

  async _delete(path, data = {}) {
    const body = JSON.stringify(data);
    const headers = { ...HEADERS_BASE, 'Content-Type': 'application/json', ...this._authHeaders('DELETE', path, body) };
    const res = await axios.delete(`${BASE}${path}`, { data, headers, timeout: 10000 });
    return res.data;
  }

  // --- Market Discovery ---

  /**
   * Fetch open events (each event contains one or more markets/tickers).
   */
  async fetchEvents({ limit = 200, cursor = '' } = {}) {
    const params = { limit, status: 'open' };
    if (cursor) params.cursor = cursor;
    const data = await this._get('/events', params);
    return { events: data.events || [], cursor: data.cursor };
  }

  /**
   * Fetch all open markets (binary YES/NO contracts).
   */
  async fetchMarkets({ limit = 200 } = {}) {
    const params = { limit, status: 'open' };
    const data = await this._get('/markets', params);
    return data.markets || [];
  }

  /**
   * Fetch markets across a curated list of series tickers.
   * Far more effective than the default /markets endpoint which returns KXMVE junk.
   */
  async fetchMarketsBySeries(seriesList, { maxPerSeries = 200, delayMs = 250 } = {}) {
    const allMarkets = [];
    for (const series of seriesList) {
      try {
        let cursor = '';
        do {
          const params = { limit: maxPerSeries, status: 'open', series_ticker: series };
          if (cursor) params.cursor = cursor;
          const data = await this._get('/markets', params);
          const ms = data.markets || [];
          allMarkets.push(...ms);
          cursor = data.cursor || '';
        } while (cursor && allMarkets.length < 2000);
      } catch { /* skip series on error */ }
      await sleep(delayMs);
    }
    return allMarkets;
  }

  /**
   * Fetch a single market by ticker.
   */
  async fetchMarket(ticker) {
    const data = await this._get(`/markets/${ticker}`);
    return data.market;
  }

  // --- Order Book ---

  /**
   * Build a synthetic order book from a market object's yes_bid/yes_ask fields.
   * Kalshi prices are in cents (1–99).
   */
  marketToOrderBook(market) {
    const bestBid = market.yes_bid || 0;
    const bestAsk = market.yes_ask || 99;
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;
    // Use 24h volume as liquidity proxy (open_interest is often 0 in API response)
    const liquidity = (market.volume_24h || market.volume || 0) * (midpoint / 100);

    return {
      ticker: market.ticker,
      bestBid,
      bestAsk,
      spread,
      midpoint,
      midpointFrac: midpoint / 100,
      liquidityUSD: liquidity,
    };
  }

  /**
   * Fetch deep order book for a specific ticker (used after pre-screening).
   */
  async fetchOrderBook(ticker) {
    try {
      const data = await this._get(`/markets/${ticker}/orderbook`);
      const ob = data.orderbook || {};
      // Kalshi returns arrays of [price_cents, size_contracts]
      const yesBids = (ob.yes || []).map(([p, s]) => ({ price: p, size: s }));
      const noBids = (ob.no || []).map(([p, s]) => ({ price: p, size: s }));
      const bestBid = yesBids.length > 0 ? yesBids[0].price : 0;
      const bestNoB = noBids.length > 0 ? noBids[0].price : 0;
      const bestAsk = bestNoB > 0 ? 100 - bestNoB : (yesBids.length ? bestBid + 2 : 99);
      const spread = bestAsk - bestBid;
      const midpoint = (bestBid + bestAsk) / 2;
      const yesLiq = (ob.yes_dollars || []).reduce((s, v) => s + v, 0);
      const noLiq = (ob.no_dollars || []).reduce((s, v) => s + v, 0);
      return {
        ticker,
        yesBids,
        noBids,
        bestBid,
        bestAsk,
        spread,
        midpoint,
        midpointFrac: midpoint / 100,
        liquidityUSD: Math.min(yesLiq || 0, noLiq || 0),
      };
    } catch {
      return null;
    }
  }

  isLiquid(ob) {
    return ob && ob.spread <= 20 && ob.midpoint > 0 && ob.midpoint < 100;
  }

  // --- Account ---

  async getBalance() {
    if (this.dryRun) return 10000;
    const data = await this._get('/portfolio/balance');
    // balance in cents → dollars
    return (data.balance || 0) / 100;
  }

  async getPositions() {
    if (this.dryRun) return [];
    const data = await this._get('/portfolio/positions');
    return (data.market_positions || []).map((p) => ({
      ticker: p.ticker,
      yesContracts: p.position,        // positive = long YES, negative = long NO
      marketValue: p.market_exposure / 100,
      realizedPnl: p.realized_pnl / 100,
    }));
  }

  // --- Order Execution ---

  /**
   * Place a limit order.
   *
   * @param {string} ticker - market ticker e.g. "BTCZ-25JAN31-T50000"
   * @param {'yes'|'no'} side - which outcome to buy
   * @param {number} priceCents - limit price in cents (1–99)
   * @param {number} sizeUSD - notional USD to spend (converted to contracts)
   * @returns order result
   */
  async placeOrder(ticker, side, priceCents, sizeUSD) {
    if (!this._authenticated && !this.dryRun) throw new Error('Not authenticated — set KALSHI_EMAIL/PASSWORD or KALSHI_API_KEY');

    const count = Math.max(1, Math.floor(sizeUSD / (priceCents / 100)));
    const clientOrderId = `sniper-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const payload = {
      ticker,
      client_order_id: clientOrderId,
      type: 'limit',
      action: 'buy',
      side,
      count,
      [`${side}_price`]: priceCents,
    };

    if (this.dryRun) {
      console.log(`[DRY RUN] BUY ${count} ${side.toUpperCase()} contracts of ${ticker} @ ${priceCents}¢ | ~$${sizeUSD.toFixed(2)} | ID: ${clientOrderId}`);
      return { order_id: clientOrderId, status: 'dry_run', payload };
    }

    const res = await this._post('/portfolio/orders', payload);
    return res.order;
  }

  async cancelOrder(orderId) {
    if (this.dryRun) {
      console.log(`[DRY RUN] Cancel ${orderId}`);
      return;
    }
    return this._delete(`/portfolio/orders/${orderId}`);
  }
}

module.exports = { KalshiClient };
