/**
 * Direct HTTP webhook bridge for Discord and Slack
 * Replaces Hermes CLI with direct HTTP calls
 */

const https = require('https');

const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

/**
 * Send message via HTTP webhook
 */
function sendWebhook(webhookUrl, payload) {
  return new Promise((resolve, reject) => {
    if (!webhookUrl) {
      return resolve({ success: false, error: 'Webhook URL not configured' });
    }

    const data = JSON.stringify(payload);
    const url = new URL(webhookUrl);

    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ success: true });
        } else {
          resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Send to Discord
 */
async function sendDiscord(text) {
  return sendWebhook(DISCORD_WEBHOOK_URL, { content: text });
}

/**
 * Send to Slack
 */
async function sendSlack(text) {
  return sendWebhook(SLACK_WEBHOOK_URL, { text });
}

module.exports = { sendDiscord, sendSlack };