/**
 * Hermes CLI bridge for Discord and Slack
 * Uses `hermes send` CLI command instead of direct webhook calls
 */

const { execSync } = require('child_process');

const HERMES_BIN = process.env.HERMES_BIN || '/root/.hermes/installs/8a4017c4cabfe15f/environments/aacddaa062d5486ea87bf528614af6f4/venv/bin/python /root/.hermes/hermes-agent/hermes';

/**
 * Send message via Hermes CLI
 */
function sendViaHermes(platform, text) {
  try {
    const output = execSync(`${HERMES_BIN} send --to ${platform} "${text.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    return { success: true, output: output.trim() };
  } catch (err) {
    return { success: false, error: err.message, stderr: err.stderr?.toString() };
  }
}

/**
 * Send to Discord via Hermes CLI
 */
async function sendDiscord(text) {
  return sendViaHermes('discord', text);
}

/**
 * Send to Slack via Hermes CLI
 */
async function sendSlack(text) {
  return sendViaHermes('slack', text);
}

module.exports = { sendDiscord, sendSlack };