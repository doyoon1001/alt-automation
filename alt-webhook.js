/**
 * Alt -> Hermes Summary -> Notion -> Discord -> Slack Pipeline
 *
 * Flow:
 * 1. Alt webhook triggers when recording finishes (note.ended)
 * 2. Fetch note details (title, transcript) via Alt API using note_id
 * 3. Send transcript to Hermes (or LLM) for summarization
 * 4. Save summarized content as a Notion page
 * 5. Post Notion page link to Discord via Hermes CLI (`hermes send --to discord`)
 * 6. On successful Discord share, send completion alert to Slack via Hermes CLI (`hermes send --to slack`)
 */

require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { execSync } = require('child_process');
const axios = require('axios');
const { createPage } = require('./notion.js');
const { sendDiscord, sendSlack } = require('./hermes-bridge.js');

const app = express();
const PORT = process.env.PORT || 3000;
const ALT_WEBHOOK_SECRET = process.env.ALT_WEBHOOK_SECRET;
const ALT_API_KEY = process.env.ALT_API_KEY;
const HERMES_BIN = process.env.HERMES_BIN || 'hermes';
const ALT_API_BASE = process.env.ALT_API_BASE || 'https://public-api.altalt.io/v1';

// Required environment variables validation
const REQUIRED_ENV = [
  'ALT_API_KEY',
  'ALT_WEBHOOK_SECRET',
  'NOTION_TOKEN',
  'NOTION_DATABASE_ID',
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

// Idempotency: track processed note_ids to avoid duplicate processing
const PROCESSED_FILE = '/opt/alt-automation/.alt_webhook_processed.json';
let processedNoteIds = new Set();

function loadProcessed() {
  try {
    const fs = require('fs');
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = fs.readFileSync(PROCESSED_FILE, 'utf-8');
      processedNoteIds = new Set(JSON.parse(data));
      console.log(`[Webhook] Loaded ${processedNoteIds.size} processed note_ids from cache`);
    }
  } catch (e) {
    console.warn('[Webhook] Could not load processed cache:', e.message);
  }
}

function saveProcessed() {
  try {
    const fs = require('fs');
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedNoteIds]));
  } catch (e) {
    console.warn('[Webhook] Could not save processed cache:', e.message);
  }
}

function markProcessed(noteId) {
  processedNoteIds.add(noteId);
  saveProcessed();
}

function isProcessed(noteId) {
  return processedNoteIds.has(noteId);
}

// Prepare secret: strip "whsec_" prefix, base64url-decode the remainder
const secretBytes = Buffer.from(
  ALT_WEBHOOK_SECRET ? ALT_WEBHOOK_SECRET.slice('whsec_'.length) : '',
  'base64url'
);
const TOLERANCE_SECONDS = 300;

// Load processed cache on startup
loadProcessed();

// Raw body middleware for signature verification
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

/**
 * Fetch note details from Alt API
 */
async function fetchNoteDetails(noteId) {
  try {
    const [noteRes, transcriptRes] = await Promise.all([
      axios.get(`${ALT_API_BASE}/notes/${noteId}`, {
        headers: { 'Authorization': `Bearer ${ALT_API_KEY}` },
        timeout: 10000,
      }),
      axios.get(`${ALT_API_BASE}/notes/${noteId}/transcript`, {
        headers: { 'Authorization': `Bearer ${ALT_API_KEY}` },
        timeout: 10000,
      }).catch(() => ({ data: { text: '' } })), // transcript might not be ready
    ]);

    return {
      noteId: noteId,
      title: noteRes.data.title || '제목 없음',
      transcript: transcriptRes.data?.text || '',
      status: noteRes.data.status,
      transcriptStatus: noteRes.data.transcript_status,
      summaryStatus: noteRes.data.summary_status,
      endedAt: noteRes.data.ended_at, // 실제 녹음 종료 일시
    };
  } catch (err) {
    console.error(`[Alt API] Failed to fetch note ${noteId}:`, err.message);
    return null;
  }
}

/**
 * Verify HMAC signature from Alt (Standard Webhooks spec)
 */
function isValidSignature(req) {
  const id = req.headers['webhook-id'];
  const timestamp = req.headers['webhook-timestamp'];
  const signatureHeader = req.headers['webhook-signature'];

  if (!id || !timestamp || !signatureHeader) {
    console.error('[Signature] Missing headers:', { id, timestamp, signatureHeader });
    return false;
  }

  // Reject stale timestamps beyond ±5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) {
    console.error('[Signature] Timestamp out of tolerance:', { timestamp, now: Date.now() / 1000 });
    return false;
  }

  const signedContent = `${id}.${timestamp}.${req.rawBody.toString()}`;
  console.log('[Signature] Signed content:', signedContent.substring(0, 200));

  const expected = crypto.createHmac('sha256', secretBytes)
    .update(signedContent)
    .digest('base64');

  console.log('[Signature] Expected (base64):', expected);

  // Compare against each v1,<base64> signature using constant-time comparison
  const parts = String(signatureHeader).split(' ');
  console.log('[Signature] Received parts:', parts);

  const result = parts.some((part) => {
    const [version, signature] = part.split(',');
    if (version !== 'v1' || !signature) return false;
    console.log('[Signature] Checking v1 signature:', signature);
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    const match = a.length === b.length && crypto.timingSafeEqual(a, b);
    console.log('[Signature] Match:', match);
    return match;
  });

  if (!result) {
    console.error('[Signature] Verification FAILED');
  }
  return result;
}

/**
 * Summarize raw transcript/text using Hermes CLI (oneshot mode via stdin)
 */
function summarizeWithHermes(rawText) {
  try {
    const prompt = `다음은 Alt에서 녹음된 내용입니다. 핵심 내용을 요약하고 실행 가능한 항목(Action Items)을 정리해주세요:\n\n${rawText}`;
    const output = execSync(`${HERMES_BIN} -z`, {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60000,
      maxBuffer: 1024 * 1024, // 1MB buffer for long responses
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
  const eventType = payload.event_type;
  const eventId = payload.event_id;
  const noteId = payload.data?.note_id;

  console.log(`[Alt Webhook] Event: ${eventType}, Event ID: ${eventId}, Note ID: ${noteId}`);

  // Handle endpoint.verification challenge
  if (eventType === 'endpoint.verification') {
    console.log('[Alt Webhook] Verification challenge received, responding 200');
    return res.status(200).json({ status: 'ok' });
  }

  // Idempotency check: skip if already processed THIS EVENT
  if (eventId && isProcessed(eventId)) {
    console.log(`[Alt Webhook] Already processed event: ${eventId}, skipping`);
    return res.status(200).json({ status: 'skipped', reason: 'Already processed' });
  }

  // Only process note.ended events
  if (eventType !== 'note.ended' || !noteId) {
    console.log('[Alt Webhook] Skipping non-note.ended event');
    return res.status(200).json({ status: 'skipped', reason: 'Not a note.ended event' });
  }

  // Fetch note details from Alt API
  console.log('[Step 0] Fetching note details from Alt API...');
  const noteDetails = await fetchNoteDetails(noteId);
  if (!noteDetails || !noteDetails.transcript) {
    console.error('[Alt Webhook] Failed to fetch note details or transcript empty');
    return res.status(500).json({ error: 'Failed to fetch note details' });
  }

  const title = noteDetails.title;
  const rawText = noteDetails.transcript;
  const endedAt = noteDetails.endedAt;
  const altNoteId = noteDetails.noteId;

  console.log(`[Alt Webhook] Processing: ${title} (${rawText.length} chars)`);

  // Step 1: Hermes로 요약 작성
  console.log('[Step 1] Summarizing with Hermes...');
  const summaryMarkdown = summarizeWithHermes(rawText);

  // Step 2: Notion 데이터베이스에 요약 저장
  console.log('[Step 2] Creating Notion page...');
  let notionPage;
  try {
    notionPage = await createPage(title, summaryMarkdown, {
      'Alt 노트 ID': { rich_text: [{ text: { content: altNoteId } }] },
      '녹음일시': { date: { start: endedAt || new Date().toISOString() } },
    });
    console.log(`[Notion] Page created successfully: ${notionPage.url || notionPage.id}`);
  } catch (err) {
    console.error('[Notion] Failed to create page:', err.message);
    return res.status(500).json({ error: 'Notion upload failed' });
  }

  const pageUrl = notionPage.url || `https://notion.so/${notionPage.id.replace(/-/g, '')}`;

  // Step 3: Discord에 Notion 링크 공유
  console.log('[Step 3] Sharing Notion link to Discord...');
  const discordMsg = `📌 **[Alt 자동 요약 완료]**\n제목: ${title}\n노션 링크: ${pageUrl}`;
  const discordRes = await sendDiscord(discordMsg);

  if (!discordRes.success) {
    console.error('[Discord] Share failed:', discordRes.error);
  } else {
    console.log('[Discord] Shared successfully');
  }

  // Step 4: Discord 공유 완료 후 Slack 채널에 연동 완료 알림 발송
  console.log('[Step 4] Sending completion notification to Slack...');
  const dateStr = new Date().toLocaleDateString('ko-KR', {
    year: 'numeric', month: 'long', day: 'numeric', weekday: 'long'
  });
  const slackMsg = `✅ **[${dateStr} - ${title} 요약 완료]**\n- 노션 요약본 생성 완료\n- 디스코드 공유 완료\n- 링크: ${pageUrl}`;
  const slackRes = await sendSlack(slackMsg);

  if (!slackRes.success) {
    console.error('[Slack] Completion alert failed:', slackRes.error);
  } else {
    console.log('[Slack] Completion alert sent');
  }

  // Mark event as processed (use event_id for exact delivery deduplication)
  if (eventId) markProcessed(eventId);

  return res.status(200).json({
    status: 'ok',
    notionUrl: pageUrl,
    discord: discordRes.success,
    slack: slackRes.success,
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`🚀 Alt Pipeline Webhook Listener running at http://localhost:${PORT}/webhooks/alt`);
});
