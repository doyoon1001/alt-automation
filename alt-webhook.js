/**
 * Alt -> Hermes Summary -> Notion -> Discord -> Slack Pipeline
 *
 * Flow:
 * 1. Alt webhook triggers when recording finishes
 * 2. Send transcript/content to Hermes (or LLM) for summarization
 * 3. Save summarized content as a Notion page
 * 4. Post Notion page link to Discord via Hermes CLI (`hermes send --to discord`)
 * 5. On successful Discord share, send completion alert to Slack via Hermes CLI (`hermes send --to slack`)
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { createPage } = require('./notion.js');
const { send: sendViaHermes } = require('./hermes-bridge.js');

const app = express();
const PORT = process.env.PORT || 3000;
const ALT_WEBHOOK_SECRET = process.env.ALT_WEBHOOK_SECRET;
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';

// Prepare secret: strip "whsec_" prefix, base64url-decode the remainder
const secretBytes = Buffer.from(
  ALT_WEBHOOK_SECRET ? ALT_WEBHOOK_SECRET.slice('whsec_'.length) : '',
  'base64url'
);
const TOLERANCE_SECONDS = 300;

// Raw body middleware for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

/**
 * Verify HMAC signature from Alt (Standard Webhooks spec)
 */
function isValidSignature(req) {
  const id = req.headers['webhook-id'];
  const timestamp = req.headers['webhook-timestamp'];
  const signatureHeader = req.headers['webhook-signature'];

  // DEBUG: log what we received
  console.log('[DEBUG] webhook-id:', id);
  console.log('[DEBUG] webhook-timestamp:', timestamp);
  console.log('[DEBUG] webhook-signature:', signatureHeader);
  console.log('[DEBUG] rawBody:', req.rawBody ? req.rawBody.toString() : 'undefined');
  console.log('[DEBUG] secretBytes length:', secretBytes.length);

  if (!id || !timestamp || !signatureHeader) return false;

  // Reject stale timestamps beyond ±5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    console.log('[DEBUG] Timestamp out of range');
    return false;
  }

  const signedContent = `${id}.${timestamp}.${req.rawBody.toString()}`;
  console.log('[DEBUG] signedContent:', signedContent);

  const expected = crypto.createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  console.log('[DEBUG] expected signature:', expected);

  // Compare against each v1,<base64> signature using constant-time comparison
  return String(signatureHeader)
    .split(' ')
    .some((part) => {
      const [version, signature] = part.split(',');
      if (version !== 'v1' || !signature) return false;
      const a = Buffer.from(signature);
      const b = Buffer.from(expected);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    });
}

/**
 * Summarize raw transcript/text using Hermes CLI or built-in template
 */
function summarizeWithHermes(rawText) {
  try {
    // Run hermes to summarize raw transcript (oneshot mode: -z)
    const prompt = `다음은 Alt에서 녹음된 내용입니다. 핵심 내용을 요약하고 실행 가능한 항목(Action Items)을 정리해주세요:\n\n${rawText}`;
    const output = execSync(`${HERMES_BIN} -z`, {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60000,
    });
    return output.trim();
  } catch (err) {
    console.warn('[Hermes Summarizer] Hermes oneshot failed or not configured, using raw fallback:', err.message);
    return `## 📝 Alt 녹음 요약\n\n${rawText}`;
  }
}

app.post('/webhooks/alt', async (req, res) => {
  console.log('[Alt Webhook] Received webhook event');

  if (!isValidSignature(req)) {
    console.error('[Alt Webhook] Signature verification failed');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = req.body;
  const rawText = payload.transcript || payload.content || payload.text || JSON.stringify(payload, null, 2);
  const title = payload.title || `Alt 녹음 요약 - ${new Date().toLocaleDateString('ko-KR')}`;

  // Step 1 & 2: Hermes로 요약 작성
  console.log('[Step 1] Summarizing with Hermes...');
  const summaryMarkdown = summarizeWithHermes(rawText);

  // Step 3: Notion 데이터베이스에 요약 저장
  console.log('[Step 2] Creating Notion page...');
  let notionPage;
  try {
    notionPage = await createPage(title, summaryMarkdown);
    console.log(`[Notion] Page created successfully: ${notionPage.url || notionPage.id}`);
  } catch (err) {
    console.error('[Notion] Failed to create page:', err.message);
    return res.status(500).json({ error: 'Notion upload failed' });
  }

  const pageUrl = notionPage.url || `https://notion.so/${notionPage.id.replace(/-/g, '')}`;

  // Step 4: Hermes를 통해 Discord 채널에 Notion 링크 공유
  console.log('[Step 3] Sharing Notion link to Discord via Hermes...');
  const discordMsg = `📌 **[Alt 자동 요약 완료]**\n제목: ${title}\n노션 링크: ${pageUrl}`;
  const discordRes = sendViaHermes('discord', discordMsg);

  if (!discordRes.success) {
    console.error('[Discord] Share failed:', discordRes.error);
  } else {
    console.log('[Discord] Shared successfully');
  }

  // Step 5: Discord 공유 완료 후 Slack 채널에 연동 완료 알림 발송
  console.log('[Step 4] Sending completion notification to Slack via Hermes...');
  const slackMsg = `✅ **[Alt 파이프라인 완결]**\n- 노션 요약본 생성 완료\n- 디스코드 공유 완료\n- 링크: ${pageUrl}`;
  const slackRes = sendViaHermes('slack', slackMsg);

  if (!slackRes.success) {
    console.error('[Slack] Completion alert failed:', slackRes.error);
  } else {
    console.log('[Slack] Completion alert sent');
  }

  return res.status(200).json({
    status: 'ok',
    notionUrl: pageUrl,
    discord: discordRes.success,
    slack: slackRes.success,
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Alt Pipeline Webhook Listener running at http://localhost:${PORT}/webhooks/alt`);
});
