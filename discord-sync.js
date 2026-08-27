const https = require("https");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GAS_URL = process.env.GAS_URL;
const SECRET = process.env.GAS_SECRET;

// รองรับหลาย Channel: ใส่ ID คั่นด้วย comma ใน secret CHANNEL_ID
// เช่น "111111111111,222222222222,333333333333"
// (ใส่ ID เดียวก็ยังใช้ได้ตามปกติ)
const CHANNEL_IDS = (process.env.CHANNEL_ID || "")
  .split(",")
  .map(id => id.trim())
  .filter(Boolean);

// ปรับตรงนี้ได้ตามต้องการ (ค่าเริ่มต้น 100 = ปกติ, ถ้ากลัวข้อความค้างเยอะปรับเป็น 200-300 ได้)
// หมายเหตุ: ค่านี้คือ "ต่อ 1 channel" ไม่ใช่รวม (ใช้เฉพาะตอน FULL_SYNC=false)
const MAX_MESSAGES = process.env.MAX_MESSAGES
  ? parseInt(process.env.MAX_MESSAGES, 10)
  : 100;

// FULL_SYNC=true -> ดึงย้อนไปจนถึงข้อความแรกสุดของ channel (ไม่จำกัดจำนวน)
// ใช้ตอน backfill ประวัติเก่าครั้งเดียว ไม่ควรตั้งค่านี้ไว้ใน cron ที่รันทุกนาที
const FULL_SYNC = String(process.env.FULL_SYNC || "").toLowerCase() === "true";

const EFFECTIVE_MAX_MESSAGES = FULL_SYNC ? Infinity : MAX_MESSAGES;

/**
 * Discord API - รองรับ pagination ดึงได้เกิน 100 ข้อความ
 * ดึงจาก channel เดียวตามที่ระบุ (channelId)
 */
async function getDiscordMessages(channelId, maxMessages = 100) {

  let allMessages = [];
  let before = null;

  while (allMessages.length < maxMessages) {

    const batchLimit = Math.min(100, maxMessages - allMessages.length);
    let url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${batchLimit}`;

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
    console.log(`  [${channelId}] Discord Status:`, response.status);

    if (!response.ok) {
      console.log(text);
      throw new Error(`Discord API Error ${response.status} (channel ${channelId}): ${text}`);
    }

    const batch = JSON.parse(text);

    if (batch.length === 0) {
      break;
    }

    allMessages = allMessages.concat(batch);
    before = batch[batch.length - 1].id;

    if (batch.length < batchLimit) {
      break;
    }

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
  console.log(`Channels: ${CHANNEL_IDS.join(", ") || "(none configured)"}`);
  console.log(FULL_SYNC
    ? "Mode: FULL SYNC (ดึงย้อนไปจนถึงข้อความแรกสุด — อาจใช้เวลานาน)"
    : `Mode: Incremental (สูงสุด ${MAX_MESSAGES} ข้อความ/channel)`);

  if (CHANNEL_IDS.length === 0) {
    console.log("ไม่มี CHANNEL_ID ที่ตั้งค่าไว้ ข้ามการทำงาน");
    return;
  }

  let allMessages = [];

  for (const channelId of CHANNEL_IDS) {
    console.log(`ดึงข้อความจาก channel: ${channelId}`);
    const messages = await getDiscordMessages(channelId, EFFECTIVE_MAX_MESSAGES);
    console.log(`  ได้รับ ${messages.length} messages`);
    allMessages = allMessages.concat(messages);

    // เผื่อ rate limit ระหว่างสลับ channel
    if (CHANNEL_IDS.indexOf(channelId) < CHANNEL_IDS.length - 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }

  console.log(`รวมทั้งหมด ${allMessages.length} messages จาก ${CHANNEL_IDS.length} channel(s)`);

  if (allMessages.length === 0) {
    console.log("ไม่มีข้อความใหม่ ข้ามการส่ง");
    return;
  }

  // ถ้าข้อความเยอะมาก ส่งเป็น chunk ละ 100 เพื่อกัน GAS payload ใหญ่เกินไป / timeout
  const CHUNK_SIZE = 100;

  for (let i = 0; i < allMessages.length; i += CHUNK_SIZE) {
    const chunk = allMessages.slice(i, i + CHUNK_SIZE);
    console.log(`ส่ง chunk ${Math.floor(i / CHUNK_SIZE) + 1} (${chunk.length} ข้อความ)`);
    await sendToAppsScript(chunk);
  }

  console.log("Sync สำเร็จ");

}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
