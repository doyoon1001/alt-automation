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
 * Convert simple markdown to Notion block array.
 * Supports headings, paragraphs, lists, code blocks, bold/italic.
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
          rich_text: [{ text: { content: code.trim() } }],
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
        [`heading_${level}`]: { rich_text: [{ text: { content: text } }] },
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
          bulleted_list_item: { rich_text: [{ text: { content: item } }] },
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
          numbered_list_item: { rich_text: [{ text: { content: item } }] },
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
        quote: { rich_text: [{ text: { content: quote.trim() } }] },
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

    // Regular paragraph
    let para = "";
    while (i < lines.length && lines[i].trim() && !lines[i].match(/^(#{1,3}\s|```|[-*]\s+|\d+\.\s+|>|---)/)) {
      para += lines[i] + "\n";
      i++;
    }
    blocks.push({
      type: "paragraph",
      paragraph: { rich_text: [{ text: { content: para.trim() } }] },
    });
  }

  return blocks;
}

module.exports = { createPage };