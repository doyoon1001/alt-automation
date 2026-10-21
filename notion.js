/**
 * Notion integration — uploads the Hermes-processed Alt note as a Notion page.
 * Uses the Notion REST API with an integration token.
 */

const axios = require("axios");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DATABASE_ID = process.env.NOTION_DATABASE_ID;

if (!NOTION_TOKEN) {
  console.error("[notion] NOTION_TOKEN not set — page uploads will fail");
}

const client = axios.create({
  baseURL: "https://api.notion.com/v1",
  headers: {
    Authorization: `Bearer ${NOTION_TOKEN}`,
    "Notion-Version": "2022-06-28",
    "Content-Type": "application/json",
  },
});

const NOTION_BLOCK_CHAR_LIMIT = 2000;

/**
 * Create a page in Notion under the configured database.
 * @param {string} title
 * @param {string} content — markdown body
 * @param {object} [properties] — extra database properties
 */
async function createPage(title, content, properties = {}) {
  const body = {
    parent: { database_id: NOTION_DATABASE_ID },
    properties: {
      Name: { title: [{ text: { content: title } }] },
      ...properties,
    },
    children: markdownToNotionBlocks(content),
  };

  const res = await client.post("/pages", body);
  return res.data;
}

/**
 * Split text into chunks respecting Notion's 2000 character limit per rich_text
 */
function splitTextForNotion(text) {
  if (text.length <= NOTION_BLOCK_CHAR_LIMIT) {
    return [text];
  }
  
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= NOTION_BLOCK_CHAR_LIMIT) {
      chunks.push(remaining);
      break;
    }
    // Find a good split point (newline or space) near the limit
    let splitIndex = NOTION_BLOCK_CHAR_LIMIT;
    const newlineIndex = remaining.lastIndexOf('\n', NOTION_BLOCK_CHAR_LIMIT);
    const spaceIndex = remaining.lastIndexOf(' ', NOTION_BLOCK_CHAR_LIMIT);
    if (newlineIndex > NOTION_BLOCK_CHAR_LIMIT * 0.5) {
      splitIndex = newlineIndex + 1;
    } else if (spaceIndex > NOTION_BLOCK_CHAR_LIMIT * 0.5) {
      splitIndex = spaceIndex + 1;
    }
    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }
  return chunks;
}

/**
 * Create rich_text array with proper splitting for Notion
 */
function createRichText(text) {
  const chunks = splitTextForNotion(text);
  return chunks.map(chunk => ({ text: { content: chunk } }));
}

/**
 * Convert simple markdown to Notion block array.
 * Supports headings, paragraphs, lists, code blocks, bold/italic, links, inline code.
 */
function markdownToNotionBlocks(md) {
  const lines = md.split("\n");
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      let code = "";
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        code += lines[i] + "\n";
        i++;
      }
      i++; // skip closing ```
      blocks.push({
        type: "code",
        code: {
          rich_text: createRichText(code.trim()),
          language: lang || "plain text",
        },
      });
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2];
      blocks.push({
        type: `heading_${level}`,
        [`heading_${level}`]: { rich_text: createRichText(text) },
      });
      i++;
      continue;
    }

    // Bullet list
    if (line.match(/^[-*]\s+(.+)/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^[-*]\s+(.+)/)) {
        items.push(lines[i].replace(/^[-*]\s+/, ""));
        i++;
      }
      items.forEach((item) => {
        blocks.push({
          type: "bulleted_list_item",
          bulleted_list_item: { rich_text: createRichText(item) },
        });
      });
      continue;
    }

    // Numbered list
    if (line.match(/^\d+\.\s+(.+)/)) {
      const items = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s+(.+)/)) {
        items.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      items.forEach((item) => {
        blocks.push({
          type: "numbered_list_item",
          numbered_list_item: { rich_text: createRichText(item) },
        });
      });
      continue;
    }

    // Blockquote
    if (line.startsWith("> ")) {
      let quote = "";
      while (i < lines.length && lines[i].startsWith("> ")) {
        quote += lines[i].replace(/^>\s/, "") + "\n";
        i++;
      }
      blocks.push({
        type: "quote",
        quote: { rich_text: createRichText(quote.trim()) },
      });
      continue;
    }

    // Divider
    if (line.trim() === "---") {
      blocks.push({ type: "divider", divider: {} });
      i++;
      continue;
    }

    // Empty line — skip
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph with inline formatting support
    let para = "";
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^(#{1,3}\s|```|[-*]\s+|\d+\.\s+>|---)/)) {
      para += lines[i] + "\n";
      i++;
    }
    blocks.push({
      type: "paragraph",
      paragraph: { rich_text: parseInlineMarkdown(para.trim()) },
    });
  }

  return blocks;
}

/**
 * Parse inline markdown (bold, italic, code, links) into Notion rich_text array
 */
function parseInlineMarkdown(text) {
  // Simple regex-based inline parsing
  // Order matters: code -> links -> bold -> italic
  const segments = [];
  let remaining = text;
  
  // Pattern for: `code`, [link](url), **bold**, *italic*
  const patterns = [
    { type: 'code', regex: /`([^`]+)`/ },
    { type: 'link', regex: /\[([^\]]+)\]\(([^)]+)\)/ },
    { type: 'bold', regex: /\*\*([^*]+)\*\*/ },
    { type: 'italic', regex: /(?<!\*)\*([^*]+)\*(?!\*)/ }, // single * not surrounded by *
  ];
  
  while (remaining.length > 0) {
    let earliestMatch = null;
    let earliestIndex = remaining.length;
    let matchedPattern = null;
    
    for (const pattern of patterns) {
      const match = remaining.match(pattern.regex);
      if (match && match.index < earliestIndex) {
        earliestIndex = match.index;
        earliestMatch = match;
        matchedPattern = pattern;
      }
    }
    
    if (!earliestMatch) {
      // No more formatting, add remaining as plain text
      if (remaining) {
        segments.push(...createRichText(remaining));
      }
      break;
    }
    
    // Add text before the match
    if (earliestIndex > 0) {
      segments.push(...createRichText(remaining.slice(0, earliestIndex)));
    }
    
    // Add the formatted segment
    if (matchedPattern.type === 'code') {
      segments.push({ text: { content: earliestMatch[1] }, code: true });
    } else if (matchedPattern.type === 'link') {
      segments.push({ text: { content: earliestMatch[1], link: { url: earliestMatch[2] } } });
    } else if (matchedPattern.type === 'bold') {
      segments.push({ text: { content: earliestMatch[1] }, annotations: { bold: true } });
    } else if (matchedPattern.type === 'italic') {
      segments.push({ text: { content: earliestMatch[1] }, annotations: { italic: true } });
    }
    
    remaining = remaining.slice(earliestIndex + earliestMatch[0].length);
  }
  
  // Filter out empty segments
  return segments.filter(s => s.text.content.length > 0);
}

module.exports = { createPage };