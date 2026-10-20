/**
 * Alt Polling Worker
 * Periodically polls Alt API for completed recordings and processes them.
 *
 * Flow:
 * 1. Poll Alt API for completed note-sessions (last 5 minutes)
 * 2. Filter out already-processed ones (track by note_id)
 * 4. For each new one: fetch transcript → Hermes summary → Notion → Slack/Discord
 * 5. Sleep and repeat
 */

require('dotenv').config();
const axios = require('axios');
const { execSync } = require('child_process');
const { createPage } = require('./notion.js');
const { send: sendViaHermes } = require('./hermes-bridge.js');

const ALT_API_KEY = process.env.ALT_API_KEY;
const POLL_INTERVAL_MS = 60 * 1000; // 1 minute
const LOOKBACK_MS = 5 * 60 * 1000; // Look back 5 minutes
const ALT_API_BASE = 'https://api.altalt.io/v1'; // Adjust based on actual API

// In-memory cache of processed note_ids (persist to file for restart resilience)
const PROCESSED_FILE = '/Users/kimdoyoon/.alt_processed.json';
let processedNoteIds = new Set();

function loadProcessed() {
  try {
    const fs = require('fs');
    if (fs.existsSync(PROCESSED_FILE)) {
      const data = fs.readFileSync(PROCESSED_FILE, 'utf-8');
      processedNoteIds = new Set(JSON.parse(data));
      console.log(`[Poller] Loaded ${processedNoteIds.size} processed note_ids from cache`);
    }
  } catch (e) {
    console.warn('[Poller] Could not load processed cache:', e.message);
  }
}

function saveProcessed() {
  try {
    const fs = require('fs');
    fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...processedNoteIds]));
  } catch (e) {
    console.warn('[Poller] Could not save processed cache:', e.message);
  }
}

function markProcessed(noteId) {
  processedNoteIds.add(noteId);
  saveProcessed();
}

function isProcessed(noteId) {
  return processedNoteIds.has(noteId);
}

/**
 * Fetch completed note-sessions from Alt API
 * Adjust endpoint/params based on actual Alt API spec
 */
async function fetchCompletedNotes() {
  try {
    const since = new Date(Date.now() - LOOKBACK_MS).toISOString();
    const response = await axios.get(`${ALT_API_BASE}/note-sessions`, {
      headers: {
        'Authorization': `Bearer ${ALT_API_KEY}`,
        'Content-Type': 'application/json',
      },
      params: {
        status: 'completed', // or 'ended', 'ready' - adjust per API
        since: since,
        limit: 50,
        sort: 'completed_at:desc',
      },
      timeout: 15000,
    });
    return response.data.data || response.data || [];
  } catch (err) {
    if (err.response) {
      console.error('[Poller] Alt API error:', err.response.status, err.response.data);
    } else {
      console.error('[Poller] Alt API request failed:', err.message);
    }
    return [];
  }
}

/**
 * Fetch full note details including transcript
 */
async function fetchNoteDetails(noteId) {
  try {
    const response = await axios.get(`${ALT_API_BASE}/note-sessions/${noteId}`, {
      headers: {
        'Authorization': `Bearer ${ALT_API_KEY}`,
      },
      timeout: 15000,
    });
    return response.data;
  } catch (err) {
    console.error(`[Poller] Failed to fetch note ${noteId}:`, err.message);
    return null;
  }
}

/**
 * Summarize transcript using Hermes CLI (oneshot mode)
 */
function summarizeWithHermes(rawText) {
  try {
    const prompt = `다음은 Alt에서 녹음된 내용입니다. 핵심 내용을 요약하고 실행 가능한 항목(Action Items)을 정리해주세요:\n\n${rawText}`;
    const output = execSync('hermes -z', {
      input: prompt,
      encoding: 'utf-8',
      timeout: 60000,
    });
    return output.trim();
  } catch (err) {
    console.warn('[Poller] Hermes summarization failed, using raw fallback:', err.message);
    return `## 📝 Alt 녹음 요약\n\n${rawText}`;
  }
}

/**
 * Process a single note: summarize → Notion → Slack/Discord
 */
async function processNote(note) {
  const noteId = note.id || note.note_id;
  const title = note.title || `Alt 녹음 ${new Date().toLocaleDateString('ko-KR')}`;
  const transcript = note.transcript || note.content || note.text || '';

  console.log(`[Poller] Processing note: ${noteId} - ${title}`);

  // 1. Summarize
  console.log('[Poller] Step 1: Summarizing with Hermes...');
  const summaryMarkdown = summarizeWithHermes(transcript);

  // 2. Create Notion page
  console.log('[Poller] Step 2: Creating Notion page...');
  let notionPage;
  try {
    notionPage = await createPage(title, summaryMarkdown, {
      'Alt 노트 ID': { rich_text: [{ text: { content: noteId } }] },
      '녹음일시': { date: { start: note.completed_at || note.ended_at || new Date().toISOString() } },
      '원본 트랜스크립트': { rich_text: [{ text: { content: transcript.slice(0, 2000) } }] },
    });
    console.log(`[Poller] Notion page created: ${notionPage.url || notionPage.id}`);
  } catch (err) {
    console.error('[Poller] Notion creation failed:', err.message);
    return false;
  }

  const pageUrl = notionPage.url || `https://notion.so/${notionPage.id.replace(/-/g, '')}`;

  // 3. Send to Discord via Hermes
  console.log('[Poller] Step 3: Sending to Discord...');
  const discordMsg = `📌 **[Alt 자동 요약 완료]**\n제목: ${title}\n노션 링크: ${pageUrl}`;
  const discordRes = sendViaHermes('discord', discordMsg);
  if (!discordRes.success) {
    console.warn('[Poller] Discord send failed:', discordRes.error);
  } else {
    console.log('[Poller] Discord sent successfully');
  }

  // 4. Send completion to Slack
  console.log('[Poller] Step 4: Sending to Slack...');
  const slackMsg = `✅ **[Alt 파이프라인 완결]**\n- 노션 요약본 생성 완료\n- 디스코드 공유 완료\n- 링크: ${pageUrl}`;
  const slackRes = sendViaHermes('slack', slackMsg);
  if (!slackRes.success) {
    console.warn('[Poller] Slack send failed:', slackRes.error);
  } else {
    console.log('[Poller] Slack sent successfully');
  }

  return true;
}

/**
 * Main polling loop
 */
async function pollOnce() {
  console.log('\n[Poller] === Polling Alt API ===');
  const notes = await fetchCompletedNotes();
  console.log(`[Poller] Found ${notes.length} completed notes`);

  for (const note of notes) {
    const noteId = note.id || note.note_id;
    if (!noteId) continue;

    if (isProcessed(noteId)) {
      console.log(`[Poller] Already processed: ${noteId}, skipping`);
      continue;
    }

    // Fetch full details if needed
    let fullNote = note;
    if (!note.transcript && !note.content) {
      fullNote = await fetchNoteDetails(noteId);
      if (!fullNote) continue;
    }

    const success = await processNote(fullNote);
    if (success) {
      markProcessed(noteId);
      console.log(`[Poller] ✅ Completed processing: ${noteId}`);
    } else {
      console.log(`[Poller] ❌ Failed processing: ${noteId}, will retry next poll`);
    }
  }
}

async function main() {
  console.log('🚀 Alt Polling Worker Started');
  console.log(`   Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`   Lookback window: ${LOOKBACK_MS / 1000}s`);
  console.log(`   Alt API: ${ALT_API_BASE}`);

  loadProcessed();

  // Initial poll
  await pollOnce();

  // Set up interval
  setInterval(async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error('[Poller] Unexpected error in poll loop:', err);
    }
  }, POLL_INTERVAL_MS);

  // Graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n[Poller] Shutting down...');
    saveProcessed();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('[Poller] Fatal error:', err);
  process.exit(1);
});