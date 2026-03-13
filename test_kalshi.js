'use strict';
require('dotenv').config();
const { KalshiClient } = require('./kalshi_client');

async function test() {
  const kalshi = new KalshiClient();
  await kalshi.login();
  
  console.log('Fetching 50 markets...');
  const markets = await kalshi.fetchMarkets({ limit: 50 });
  console.log(`Fetched ${markets.length} markets`);
  
  const priced = markets.filter(m => (m.yes_bid || 0) > 0 || (m.yes_ask || 0) > 0);
  console.log(`${priced.length} markets have price data in the list`);
  
  if (markets.length > 0) {
    const ticker = markets[0].ticker;
    console.log(`Fetching orderbook for ${ticker}...`);
    const ob = await kalshi.fetchOrderBook(ticker);
    console.log('Orderbook:', JSON.stringify(ob, null, 2));
  }
}

test().catch(console.error);
