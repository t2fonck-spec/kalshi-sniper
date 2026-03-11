# Kalshi Sniper Bot

A quantitative prediction market bot for Kalshi (CFTC-regulated).

## Features
- **Scout**: Monitors Kalshi events for mispriced markets.
- **Analyst**: Uses Claude (thinking-enabled) to estimate true probabilities based on real-time news.
- **Sniper**: Executes limit orders based on Kelly Criterion betting sizing.
- **Dashboard**: Real-time web-based dashboard (port 4242) for monitoring trades and state.

## Setup
1. Clone the repo
2. Run `npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `KALSHI_EMAIL` & `KALSHI_PASSWORD` (or API Key)
   - `ANTHROPIC_API_KEY`
4. Run `npm start` or `npm run dry`

## Caution
This is experimental software. Trading prediction markets involves risk of capital loss. Always test in `DRY_RUN=true` mode first.
