const https = require("https");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID;
const GAS_URL = process.env.GAS_URL;
const SECRET = process.env.GAS_SECRET;

// ปรับตรงนี้ได้ตามต้องการ (ค่าเริ่มต้น 100 = ปกติ, ถ้ากลัวข้อความค้างเยอะปรับเป็น 200-300 ได้)
const MAX_MESSAGES = process.env.MAX_MESSAGES
  ? parseInt(process.env.MAX_MESSAGES, 10)
  : 100;

/**
 * Discord API - รองรับ pagination ดึงได้เกิน 100 ข้อความ
 */
async function getDiscordMessages(maxMessages = 100) {
  let allMessages = [];
  let before = null;

  while (allMessages.length < maxMessages) {
    const batchLimit = Math.min(100, maxMessages - allMessages.length);

    let url = `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages?limit=${batchLimit}`;
    if (before) {
      url += `&before=${before}`;
    }

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Authorization": `Bot ${DISCORD_TOKEN}`,
        "User-Agent": "DiscordDutySync/1.0",
        "Accept": "application/json"
      }
    });

    const text = await response.text();
    console.log("Discord Status:", response.status);

    if (!response.ok) {
      console.log(text);
      throw new Error(`Discord API Error ${response.status}: ${text}`);
    }

    const batch = JSON.parse(text);

    if (batch.length === 0) {
      // ไม่มีข้อความเก่ากว่านี้แล้ว
      break;
    }

    allMessages = allMessages.concat(batch);
    before = batch[batch.length - 1].id;

    if (batch.length < batchLimit) {
      // ได้น้อยกว่าที่ขอ แปลว่าหมดแชนแนลแล้ว
      break;
    }

    // เผื่อ rate limit นิดหน่อยระหว่าง batch
    if (allMessages.length < maxMessages) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  return allMessages;
}

/**
 * ส่งไป Apps Script
 */
async function sendToAppsScript(messages) {
  const response = await fetch(GAS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      secret: SECRET,
      messages: messages
    })
  });

  const text = await response.text();
  console.log("Apps Script:", response.status, text);

  if (!response.ok) {
    throw new Error(`Apps Script Error ${response.status}: ${text}`);
  }
}

/**
 * Main
 */
async function main() {
  console.log("==============================");
  console.log("Discord Duty Sync");
  console.log("==============================");
  console.log(`Max messages: ${MAX_MESSAGES}`);

  const messages = await getDiscordMessages(MAX_MESSAGES);

  console.log(`ได้รับ ${messages.length} messages`);

  if (messages.length === 0) {
    console.log("ไม่มีข้อความใหม่ ข้ามการส่ง");
    return;
  }

  // ถ้าข้อความเยอะมาก ส่งเป็น chunk ละ 100 เพื่อกัน GAS payload ใหญ่เกินไป / timeout
  const CHUNK_SIZE = 100;
  for (let i = 0; i < messages.length; i += CHUNK_SIZE) {
    const chunk = messages.slice(i, i + CHUNK_SIZE);
    console.log(`ส่ง chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} ข้อความ)`);
    await sendToAppsScript(chunk);
  }

  console.log("Sync สำเร็จ");
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});