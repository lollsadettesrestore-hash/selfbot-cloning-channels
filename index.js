require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const SOURCE_CATEGORY_ID = process.env.SOURCE_CATEGORY_ID?.trim();
const TARGET_CATEGORY_ID = process.env.TARGET_CATEGORY_ID?.trim();

const INVISIBLE_AVATAR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];

const client = new Client({ checkUpdate: false });

function saveProgress(channelId, index) {
  fs.writeFileSync(`progress_${channelId}.json`, JSON.stringify({ last_sent: index }));
}

function loadProgress(channelId) {
  const file = `progress_${channelId}.json`;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file)).last_sent || 0;
  return 0;
}

async function createWebhook(channelId) {
  try {
    const res = await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/webhooks`,
      { name: "UPLOADER", avatar: INVISIBLE_AVATAR },
      { headers: { Authorization: TOKEN, "Content-Type": "application/json" } }
    );
    const { id, token } = res.data;
    console.log(`✅ Webhook creato nel canale ${channelId}`);
    return `https://discord.com/api/webhooks/${id}/${token}`;
  } catch (e) {
    console.error(`❌ Errore webhook: ${e.response?.status} ${e.message}`);
    return null;
  }
}

async function sendWithRetry(webhookUrl, payload, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.post(webhookUrl, payload, {
        headers: { "Content-Type": "application/json" },
        validateStatus: () => true,
      });
      if (res.status === 429) {
        const retryAfter = res.data?.retry_after || 5;
        console.log(`⏳ Rate limit — aspetto ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 200 || res.status === 204) return true;
      console.warn(`⚠️ Status ${res.status} — ritento (${attempt + 1}/${retries})`);
      await sleep(3000);
    } catch (e) {
      console.error(`❌ Errore invio: ${e.message} — ritento (${attempt + 1}/${retries})`);
      await sleep(5000);
    }
  }
  return false;
}

async function scrapeChannel(channel) {
  const videos = [];
  console.log(`▶ Scraping #${channel.name}...`);

  let lastId = null;
  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;

    const messages = await channel.messages.fetch(options);
    if (messages.size === 0) break;

    messages.forEach((msg) => {
      msg.attachments.forEach((att) => {
        if (VIDEO_EXTENSIONS.some((ext) => att.name?.toLowerCase().endsWith(ext))) {
          videos.push(att.url);
        }
      });
    });

    lastId = messages.last()?.id;
    await sleep(1000);
  }

  console.log(`✅ #${channel.name} → ${videos.length} video trovati`);
  return videos;
}

async function mirrorChannel(sourceChannel, targetChannel) {
  const webhookUrl = await createWebhook(targetChannel.id);
  if (!webhookUrl) {
    console.error(`❌ Webhook fallito per #${targetChannel.name}, salto.`);
    return;
  }

  const videos = await scrapeChannel(sourceChannel);
  if (videos.length === 0) {
    console.log(`⚠️ Nessun video in #${sourceChannel.name}, salto.`);
    return;
  }

  const pairs = [];
  for (let i = 0; i < videos.length; i += 2) pairs.push(videos.slice(i, i + 2));

  const startFrom = loadProgress(sourceChannel.id);
  console.log(`▶ #${sourceChannel.name} — riprendo da coppia #${startFrom + 1}/${pairs.length}`);

  for (let i = startFrom; i < pairs.length; i++) {
    const ok = await sendWithRetry(webhookUrl, {
      username: "SENSATIONAL",
      content: pairs[i].join("\n"),
    });
    if (ok) {
      saveProgress(sourceChannel.id, i + 1);
      console.log(`  [#${sourceChannel.name}] ${i + 1}/${pairs.length} ✅`);
    } else {
      console.error(`  [#${sourceChannel.name}] ${i + 1}/${pairs.length} ❌`);
    }
    await sleep(2200);
  }

  const file = `progress_${sourceChannel.id}.json`;
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log(`🏁 #${sourceChannel.name} → #${targetChannel.name} completato!`);
}

client.on("ready", async () => {
  console.log(`\n🤖 Loggato come ${client.user.tag}`);
  console.log(`📋 Guild in cache: ${client.guilds.cache.size}`);
  console.log(`SOURCE_CATEGORY_ID: "${SOURCE_CATEGORY_ID}"`);
  console.log(`TARGET_CATEGORY_ID: "${TARGET_CATEGORY_ID}"`);

  for (const guild of client.guilds.cache.values()) {
    console.log(`\n📌 Server: ${guild.name} (${guild.id})`);

    await guild.channels.fetch();
    console.log(`Canali in cache dopo fetch: ${guild.channels.cache.size}`);

    const sourceCategory = guild.channels.cache.get(SOURCE_CATEGORY_ID);
    const targetCategory = guild.channels.cache.get(TARGET_CATEGORY_ID);

    console.log(`Sorgente → ${sourceCategory ? sourceCategory.name : "❌ NON TROVATA"}`);
    console.log(`Target   → ${targetCategory ? targetCategory.name : "❌ NON TROVATA"}`);

    if (!sourceCategory || !targetCategory) continue;

    const sourceChannels = guild.channels.cache
      .filter((ch) => ch.parentId === SOURCE_CATEGORY_ID && ch.isText())
      .sort((a, b) => a.position - b.position)
      .toJSON();

    const targetChannels = guild.channels.cache
      .filter((ch) => ch.parentId === TARGET_CATEGORY_ID && ch.isText())
      .sort((a, b) => a.position - b.position)
      .toJSON();

    console.log(`📂 ${sourceChannels.length} canali sorgente | ${targetChannels.length} canali target`);

    const pairs = sourceChannels
      .map((src, i) => ({ source: src, target: targetChannels[i] }))
      .filter((p) => p.source && p.target);

    await Promise.all(pairs.map(({ source, target }) => mirrorChannel(source, target)));

    console.log("\n🎯 Tutti i canali completati!");
  }

  process.exit(0);
});

client.login(TOKEN);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
