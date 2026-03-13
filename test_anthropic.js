'use strict';
require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

async function test() {
  const client = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  console.log('Testing Anthropic API...');
  try {
    const response = await client.messages.create({
      model: 'claude-3-haiku-20240307',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'Say hello' }],
    });
    console.log('Anthropic Response:', response.content[0].text);
  } catch (err) {
    console.error('Anthropic Error:', err.message);
  }
}

test().catch(console.error);
