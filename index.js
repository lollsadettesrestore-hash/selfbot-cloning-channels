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

// ─── Crea canale testo nel server target ──────────────────────────────────────

async function createChannel(guild, name, categoryId) {
  try {
    const ch = await guild.channels.create(name, {
      type: "GUILD_TEXT",
      parent: categoryId,
    });
    console.log(`✅ Canale creato: #${ch.name}`);
    return ch;
  } catch (e) {
    console.error(`❌ Errore creazione canale ${name}: ${e.message}`);
    return null;
  }
}

// ─── Crea webhook ─────────────────────────────────────────────────────────────

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
        if (VIDEO_EXTENSIONS.some((ext) => att.name?.toLowerCase().endsWith(ext)))
          videos.push(att.url);
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

async function findCategory(categoryId) {
  for (const guild of client.guilds.cache.values()) {
    await guild.channels.fetch();
    const category = guild.channels.cache.get(categoryId);
    if (category) {
      const channels = guild.channels.cache
        .filter((ch) => ch.parentId === categoryId && ch.isText())
        .sort((a, b) => a.position - b.position)
        .toJSON();
      console.log(`📌 Categoria "${category.name}" in "${guild.name}" → ${channels.length} canali`);
      return { guild, category, channels };
    }
  }
  return null;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

client.on("ready", async () => {
  console.log(`\n🤖 Loggato come ${client.user.tag}`);

  const source = await findCategory(SOURCE_CATEGORY_ID);
  const target = await findCategory(TARGET_CATEGORY_ID);

  if (!source) { console.error(`❌ Categoria sorgente non trovata!`); process.exit(1); }
  if (!target) { console.error(`❌ Categoria target non trovata!`); process.exit(1); }

  // Crea i canali mancanti nel target copiando i nomi dalla sorgente
  let targetChannels = target.channels;
  if (targetChannels.length === 0) {
    console.log(`\n⚙️ Nessun canale nel target — li creo ora...`);
    for (const srcCh of source.channels) {
      const newCh = await createChannel(target.guild, srcCh.name, TARGET_CATEGORY_ID);
      if (newCh) targetChannels.push(newCh);
      await sleep(500);
    }
  }

  console.log(`\n📂 Sorgente: ${source.channels.length} canali`);
  console.log(`📂 Target:   ${targetChannels.length} canali`);

  const pairs = source.channels
    .map((src, i) => ({ source: src, target: targetChannels[i] }))
    .filter((p) => p.source && p.target);

  console.log(`🔗 Coppie abbinate: ${pairs.length}\n`);

  await Promise.all(pairs.map(({ source, target }) => mirrorChannel(source, target)));

  console.log("\n🎯 Tutti i canali completati!");
  process.exit(0);
});

client.login(TOKEN);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
