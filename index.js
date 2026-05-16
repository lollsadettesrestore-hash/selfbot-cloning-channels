require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const axios = require("axios");
const fs = require("fs");

const TOKEN = process.env.DISCORD_TOKEN;
const SOURCE_CATEGORY_ID = process.env.SOURCE_CATEGORY_ID;
const TARGET_CATEGORY_ID = process.env.TARGET_CATEGORY_ID;

// Avatar 1x1 pixel trasparente
const INVISIBLE_AVATAR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];

const client = new Client({ checkUpdate: false });

// ─── Progressione ────────────────────────────────────────────────────────────

function saveProgress(channelId, index) {
  fs.writeFileSync(
    `progress_${channelId}.json`,
    JSON.stringify({ last_sent: index })
  );
}

function loadProgress(channelId) {
  const file = `progress_${channelId}.json`;
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file)).last_sent || 0;
  }
  return 0;
}

// ─── Crea webhook nel canale target ──────────────────────────────────────────

async function createWebhook(channelId) {
  try {
    const res = await axios.post(
      `https://discord.com/api/v10/channels/${channelId}/webhooks`,
      { name: "UPLOADER", avatar: INVISIBLE_AVATAR },
      {
        headers: {
          Authorization: TOKEN,
          "Content-Type": "application/json",
        },
      }
    );
    const { id, token } = res.data;
    console.log(`✅ Webhook creato nel canale ${channelId}`);
    return `https://discord.com/api/webhooks/${id}/${token}`;
  } catch (e) {
    console.error(`❌ Errore creazione webhook: ${e.response?.status} ${e.message}`);
    return null;
  }
}

// ─── Invia con retry e gestione rate limit ────────────────────────────────────

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

// ─── Scraping canale sorgente ─────────────────────────────────────────────────

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
    await sleep(1000); // pausa tra fetch per non stressare l'API
  }

  console.log(`✅ #${channel.name} → ${videos.length} video trovati`);
  return videos;
}

// ─── Mirror di un singolo canale ─────────────────────────────────────────────

async function mirrorChannel(sourceChannel, targetChannel) {
  const webhookUrl = await createWebhook(targetChannel.id);
  if (!webhookUrl) {
    console.error(`❌ Impossibile creare webhook per #${targetChannel.name}, salto.`);
    return;
  }

  const videos = await scrapeChannel(sourceChannel);
  if (videos.length === 0) {
    console.log(`⚠️ Nessun video in #${sourceChannel.name}, salto.`);
    return;
  }

  const pairs = [];
  for (let i = 0; i < videos.length; i += 2) {
    pairs.push(videos.slice(i, i + 2));
  }

  const startFrom = loadProgress(sourceChannel.id);
  console.log(`▶ #${sourceChannel.name} — riprendo dalla coppia #${startFrom + 1}/${pairs.length}`);

  for (let i = startFrom; i < pairs.length; i++) {
    const pair = pairs[i];
    const payload = {
      username: "SENSATIONAL",
      content: pair.join("\n"),
    };

    const ok = await sendWithRetry(webhookUrl, payload);
    if (ok) {
      saveProgress(sourceChannel.id, i + 1);
      console.log(`  [#${sourceChannel.name}] ${i + 1}/${pairs.length} ✅`);
    } else {
      console.error(`  [#${sourceChannel.name}] ${i + 1}/${pairs.length} ❌ fallita dopo tutti i retry`);
    }

    await sleep(2200);
  }

  // Pulizia file progresso
  const file = `progress_${sourceChannel.id}.json`;
  if (fs.existsSync(file)) fs.unlinkSync(file);
  console.log(`🏁 #${sourceChannel.name} → #${targetChannel.name} completato!`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

client.on("ready", async () => {
  console.log(`\n🤖 Loggato come ${client.user.tag}`);

  for (const guild of client.guilds.cache.values()) {
    const sourceCategory = guild.channels.cache.get(SOURCE_CATEGORY_ID);
    const targetCategory = guild.channels.cache.get(TARGET_CATEGORY_ID);

    if (!sourceCategory || !targetCategory) continue;

    const sourceChannels = guild.channels.cache
      .filter((ch) => ch.parentId === SOURCE_CATEGORY_ID && ch.isText())
      .sort((a, b) => a.position - b.position)
      .toJSON();

    const targetChannels = guild.channels.cache
      .filter((ch) => ch.parentId === TARGET_CATEGORY_ID && ch.isText())
      .sort((a, b) => a.position - b.position)
      .toJSON();

    console.log(`\n📂 Trovati ${sourceChannels.length} canali sorgente`);
    console.log(`📂 Trovati ${targetChannels.length} canali target\n`);

    // Abbina canali per posizione (1° sorgente → 1° target, ecc.)
    const pairs = sourceChannels.map((src, i) => ({
      source: src,
      target: targetChannels[i],
    })).filter((p) => p.source && p.target);

    // Avvia tutti in parallelo
    await Promise.all(pairs.map(({ source, target }) => mirrorChannel(source, target)));

    console.log("\n🎯 Tutti i canali completati!");
  }

  process.exit(0);
});

client.login(TOKEN);

// ─── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
