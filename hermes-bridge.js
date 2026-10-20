/**
 * Hermes Bridge — wraps the Hermes CLI (`hermes send`) so the Alt webhook
 * pipeline can deliver to Discord and Telegram through Hermes's already-
 * configured platform plugins.
 *
 * Hermes has Discord + Telegram configured in ~/.hermes/config.yaml, so we
 * don't need separate Discord/Telegram bot tokens here — we just call the CLI.
 */

const { execSync } = require("child_process");

const HERMES_BIN = process.env.HERMES_BIN || "hermes";

/**
 * Send a message to a Hermes-configured platform.
 * @param {"telegram" | "discord" | "slack"} platform
 * @param {string} text
 * @param {{threadId?: string, channelId?: string}} [opts]
 */
function send(platform, text, opts = {}) {
  const args = ["send", "--to", platform];

  if (opts.threadId) args.push("--thread", opts.threadId);
  if (opts.channelId) args.push("--channel", opts.channelId);

  args.push("--file", "-"); // read body from stdin

  try {
    execSync(`${HERMES_BIN} ${args.join(" ")}`, {
      input: text,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    return { success: true, platform };
  } catch (err) {
    return { success: false, platform, error: err.message };
  }
}

module.exports = { send };