require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

const TOKEN = process.env.DISCORD_TOKEN;
const SOURCE_CATEGORY_ID = process.env.SOURCE_CATEGORY_ID?.trim() || null;
const TARGET_CATEGORY_ID = process.env.TARGET_CATEGORY_ID?.trim() || null;
const SOURCE_THREAD_ID   = process.env.SOURCE_THREAD_ID?.trim()   || null;
const TARGET_THREAD_ID   = process.env.TARGET_THREAD_ID?.trim()   || null;
const SOURCE_GUILD_ID    = process.env.SOURCE_GUILD_ID?.trim()    || null;
const TARGET_GUILD_ID    = process.env.TARGET_GUILD_ID?.trim()    || null;

const INVISIBLE_AVATAR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];
const IMAGE_EXTENSIONS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const MEDIA_EXTENSIONS = [...VIDEO_EXTENSIONS, ...IMAGE_EXTENSIONS];

const CONTENT_TYPE_MAP = {
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska", ".webm": "video/webm",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp",
};

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const client = new Client({ checkUpdate: false });

process.on("uncaughtException",  (err) => console.error(`💥 uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (r)   => console.error(`💥 unhandledRejection: ${r?.stack || r}`));

// ─── Utility ──────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMediaExt(name) {
  if (!name) return null;
  const lower = name.toLowerCase();
  return MEDIA_EXTENSIONS.find((e) => lower.endsWith(e) || lower.includes(e)) ?? null;
}

// ─── Progresso ────────────────────────────────────────────────────────────────
function saveProgress(id, sentUrls) {
  try {
    fs.writeFileSync(`progress_${id}.json`, JSON.stringify({ sent_urls: [...sentUrls] }));
  } catch (e) {
    console.error(`❌ Errore salvataggio progresso: ${e.message}`);
  }
}

function loadProgress(id) {
  try {
    const file = `progress_${id}.json`;
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file));
      const urls = new Set(data.sent_urls || []);
      console.log(`📂 Progresso caricato: ${urls.size} URL già inviati`);
      return urls;
    }
  } catch (e) {
    console.warn(`⚠️ Errore lettura progresso: ${e.message}`);
  }
  return new Set();
}

function clearProgress(id) {
  try {
    const file = `progress_${id}.json`;
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (_) {}
}

// ─── Canali ───────────────────────────────────────────────────────────────────
async function createChannel(guild, name, categoryId, type = "GUILD_TEXT") {
  try {
    const ch = await guild.channels.create(name, { type, parent: categoryId });
    console.log(`✅ Canale creato: #${ch.name}`);
    return ch;
  } catch (e) {
    console.error(`❌ Errore creazione canale ${name}: ${e.message}`);
    return null;
  }
}

// ─── Webhook con retry su 429 ─────────────────────────────────────────────────
async function createWebhook(channelId, retries = 8) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.post(
        `https://discord.com/api/v10/channels/${channelId}/webhooks`,
        { name: "UPLOADER", avatar: INVISIBLE_AVATAR },
        {
          headers: { Authorization: TOKEN, "Content-Type": "application/json" },
          validateStatus: () => true,
        }
      );

      if (res.status === 429) {
        const retryAfter = (res.data?.retry_after ?? 5) + 1;
        console.warn(`  ⏳ Webhook 429 (canale ${channelId}) — aspetto ${retryAfter.toFixed(1)}s (${attempt + 1}/${retries})`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 200 || res.status === 201) {
        const { id, token } = res.data;
        console.log(`✅ Webhook creato nel canale ${channelId}`);
        return `https://discord.com/api/webhooks/${id}/${token}`;
      }

      console.warn(`  ⚠️ Webhook status ${res.status} — ritento (${attempt + 1}/${retries})`);
      await sleep(2000 * (attempt + 1));
    } catch (e) {
      console.error(`❌ Errore webhook: ${e.message} — ritento (${attempt + 1}/${retries})`);
      await sleep(2000 * (attempt + 1));
    }
  }
  console.error(`❌ Webhook fallito definitivamente per canale ${channelId}`);
  return null;
}

async function createAllWebhooks(channelPairs) {
  const result = [];
  for (const pair of channelPairs) {
    const webhookUrl = await createWebhook(pair.target.id);
    result.push({ ...pair, webhookUrl });
    if (result.length < channelPairs.length) await sleep(800);
  }
  return result;
}

// ─── Scraping messaggi via REST (funziona su canali e thread) ────────────────
async function fetchMessagesREST(channelId, before = null) {
  const params = new URLSearchParams({ limit: "100" });
  if (before) params.set("before", before);
  const res = await axios.get(
    `https://discord.com/api/v10/channels/${channelId}/messages?${params}`,
    { headers: { Authorization: TOKEN }, validateStatus: () => true }
  );
  if (res.status === 429) {
    const retryAfter = (res.data?.retry_after ?? 3) + 0.5;
    console.warn(`  ⏳ Rate limit messaggi — aspetto ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return fetchMessagesREST(channelId, before);
  }
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  return res.data; // array di messaggi raw
}

async function scrapeMessages(channel) {
  const media = [];
  const seen = new Set();
  let lastId = null;
  let stuckGuard = 0;

  while (true) {
    try {
      const messages = await fetchMessagesREST(channel.id, lastId);
      if (!messages.length) break;

      const newLastId = messages[messages.length - 1]?.id;
      if (newLastId === lastId) {
        if (++stuckGuard >= 3) { console.warn(`⚠️ Loop bloccato in #${channel.name}, esco.`); break; }
      } else { stuckGuard = 0; }
      lastId = newLastId;

      for (const msg of messages) {
        // Allegati (video + foto)
        for (const att of (msg.attachments || [])) {
          const ext = getMediaExt(att.filename || att.url);
          if (ext && !seen.has(att.url)) {
            seen.add(att.url);
            media.push({ url: att.url, ext, messageId: msg.id });
          }
        }
        // Embed video + immagini
        for (const embed of (msg.embeds || [])) {
          const videoUrl = embed.video?.url || embed.video?.proxy_url;
          if (videoUrl && !seen.has(videoUrl)) {
            const ext = getMediaExt(videoUrl);
            if (ext) { seen.add(videoUrl); media.push({ url: videoUrl, ext, messageId: msg.id }); }
          }
          const imgUrl = embed.image?.url || embed.thumbnail?.url;
          if (imgUrl && !seen.has(imgUrl)) {
            const ext = getMediaExt(imgUrl);
            if (ext) { seen.add(imgUrl); media.push({ url: imgUrl, ext, messageId: msg.id }); }
          }
        }
      }

      await sleep(500);
    } catch (e) {
      console.error(`❌ Errore fetch messaggi in #${channel.name}: ${e.message} — riprovo tra 3s`);
      await sleep(3000);
    }
  }

  return media;
}

async function scrapeChannel(channel) {
  console.log(`▶ Scraping #${channel.name}...`);
  const media = await scrapeMessages(channel);
  console.log(`✅ #${channel.name} → ${media.length} media unici trovati`);
  return media;
}

// ─── Scraping threads / forum posts ──────────────────────────────────────────
async function scrapeThreads(channel) {
  const threads = [];
  try {
    const active = await channel.threads.fetchActive().catch(() => ({ threads: { values: () => [] } }));
    for (const t of active.threads.values()) threads.push(t);

    let before = null;
    while (true) {
      const opts = { limit: 100 };
      if (before) opts.before = before;
      const archived = await channel.threads.fetchArchived(opts).catch(() => null);
      if (!archived || archived.threads.size === 0) break;
      for (const t of archived.threads.values()) threads.push(t);
      if (!archived.hasMore) break;
      before = archived.threads.last()?.id;
    }
  } catch (e) {
    console.warn(`⚠️ Errore fetch threads in #${channel.name}: ${e.message}`);
  }
  return threads;
}

// ─── Download singolo media ───────────────────────────────────────────────────
async function downloadMedia(item, channel, retries = 5) {
  let { url, ext, messageId } = item;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await axios.get(url, {
        responseType: "arraybuffer",
        timeout: 120000,
        validateStatus: () => true,
      });

      if (res.status === 403 || res.status === 401) {
        console.warn(`  🔄 URL scaduta (${res.status}), ri-fetch messaggio ${messageId}...`);
        if (messageId && channel) {
          try {
            const msg = await channel.messages.fetch(messageId);
            const freshAtt = [...msg.attachments.values()].find((a) => getMediaExt(a.name));
            if (freshAtt) { url = freshAtt.url; item.url = url; continue; }
            const freshEmbed = msg.embeds.find((em) => em.video?.url || em.image?.url);
            if (freshEmbed) { url = freshEmbed.video?.url || freshEmbed.image?.url; item.url = url; continue; }
          } catch (fetchErr) {
            console.warn(`  ⚠️ Impossibile ri-fetchare messaggio: ${fetchErr.message}`);
          }
        }
        return null;
      }

      if (res.status !== 200) { await sleep(2000 * (attempt + 1)); continue; }

      const buffer = Buffer.from(res.data);
      if (buffer.length > MAX_UPLOAD_BYTES) {
        console.warn(`  ⚠️ File troppo grande (${(buffer.length / 1024 / 1024).toFixed(1)} MB > 25 MB), saltato: ${url}`);
        return null;
      }

      return { buffer, ext, url };
    } catch (e) {
      console.warn(`  ⚠️ Download fallito (${attempt + 1}/${retries}): ${e.message}`);
      if (attempt < retries - 1) await sleep(2000 * (attempt + 1));
    }
  }
  console.error(`  ❌ Download fallito definitivamente: ${url}`);
  return null;
}

// ─── Download parallelo coppia ────────────────────────────────────────────────
async function downloadPair(pair, channel, globalIndex) {
  const results = await Promise.all(pair.map((item) => downloadMedia(item, channel)));
  const files = [];
  results.forEach((result, i) => {
    if (!result) { console.warn(`  ⚠️ Media ${i + 1} non scaricabile — saltato.`); return; }
    const idx = globalIndex + i + 1;
    const filename = `SENSATIONAL_${String(idx).padStart(4, "0")}${result.ext}`;
    const contentType = CONTENT_TYPE_MAP[result.ext] ?? "application/octet-stream";
    files.push({ buffer: result.buffer, filename, contentType, url: result.url });
  });
  return files;
}

// ─── Invio file via webhook (con thread_id opzionale) ────────────────────────
async function sendSingleFile(webhookUrl, file, threadId = null, retries = 5) {
  const url = threadId ? `${webhookUrl}?thread_id=${threadId}` : webhookUrl;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ username: "SENSATIONAL" }));
      form.append("files[0]", file.buffer, { filename: file.filename, contentType: file.contentType });

      const res = await axios.post(url, form, {
        headers: form.getHeaders(),
        validateStatus: () => true,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 180000,
      });

      if (res.status === 429) {
        const retryAfter = (res.data?.retry_after ?? 3) + 0.5;
        console.log(`  ⏳ Rate limit — aspetto ${retryAfter}s`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (res.status === 413) {
        console.warn(`  ⚠️ File troppo grande (413), saltato: ${file.filename}`);
        return null;
      }
      if (res.status === 200 || res.status === 204) return file.url;

      console.warn(`  ⚠️ Status ${res.status} — ritento (${attempt + 1}/${retries})`);
      await sleep(3000 * (attempt + 1));
    } catch (e) {
      console.error(`  ❌ Errore invio: ${e.message} — ritento (${attempt + 1}/${retries})`);
      await sleep(4000 * (attempt + 1));
    }
  }
  return null;
}

async function sendFiles(webhookUrl, files, threadId = null) {
  if (files.length === 0) return [];

  const totalSize = files.reduce((sum, f) => sum + f.buffer.length, 0);

  if (totalSize <= MAX_UPLOAD_BYTES) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const reqUrl = threadId ? `${webhookUrl}?thread_id=${threadId}` : webhookUrl;
        const form = new FormData();
        form.append("payload_json", JSON.stringify({ username: "SENSATIONAL" }));
        files.forEach(({ buffer, filename, contentType }, i) => {
          form.append(`files[${i}]`, buffer, { filename, contentType });
        });

        const res = await axios.post(reqUrl, form, {
          headers: form.getHeaders(),
          validateStatus: () => true,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 180000,
        });

        if (res.status === 429) {
          const retryAfter = (res.data?.retry_after ?? 3) + 0.5;
          console.log(`  ⏳ Rate limit — aspetto ${retryAfter}s`);
          await sleep(retryAfter * 1000);
          continue;
        }
        if (res.status === 413) { console.warn(`  ⚠️ 413 sul batch — invio uno per uno`); break; }
        if (res.status === 200 || res.status === 204) return files.map((f) => f.url);

        console.warn(`  ⚠️ Status ${res.status} — ritento (${attempt + 1}/5)`);
        await sleep(3000 * (attempt + 1));
      } catch (e) {
        console.error(`  ❌ Errore invio batch: ${e.message} — ritento (${attempt + 1}/5)`);
        await sleep(4000 * (attempt + 1));
      }
    }
  }

  // Fallback: un file alla volta
  const sentUrls = [];
  for (const file of files) {
    const sentUrl = await sendSingleFile(webhookUrl, file, threadId);
    if (sentUrl) { sentUrls.push(sentUrl); await sleep(500); }
  }
  return sentUrls;
}

// ─── Mirror core (canale o thread) ───────────────────────────────────────────
async function mirrorMedia(label, sourceChannel, webhookUrl, threadId = null) {
  const media = await scrapeChannel(sourceChannel);
  if (media.length === 0) {
    console.log(`⚠️ Nessun media in ${label}, salto.`);
    return;
  }

  const progressKey = threadId ? `thread_${threadId}` : sourceChannel.id;
  const sentUrls = loadProgress(progressKey);
  const pending = media.filter((m) => !sentUrls.has(m.url));
  console.log(`▶ ${label} — ${sentUrls.size} già inviati, ${pending.length} rimanenti su ${media.length} totali`);

  if (pending.length === 0) { console.log(`✅ ${label} già completato.`); return; }

  const pairs = [];
  for (let i = 0; i < pending.length; i += 2) pairs.push(pending.slice(i, i + 2));

  const startTime = Date.now();
  let globalIndex = sentUrls.size;
  let nextFilesPromise = downloadPair(pairs[0], sourceChannel, globalIndex);

  for (let i = 0; i < pairs.length; i++) {
    try {
      const files = await nextFilesPromise;

      if (i + 1 < pairs.length) {
        nextFilesPromise = downloadPair(pairs[i + 1], sourceChannel, globalIndex + pairs[i].length);
      }

      const sentNow = await sendFiles(webhookUrl, files, threadId);

      if (sentNow.length > 0) {
        sentNow.forEach((url) => sentUrls.add(url));
        saveProgress(progressKey, sentUrls);
        globalIndex += sentNow.length;

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
        const rate = ((i + 1) / Math.max(elapsed, 1) * 60).toFixed(1);
        console.log(`  [${label}] ${i + 1}/${pairs.length} ✅  (${elapsed}s — ~${rate} coppie/min)`);
      } else {
        console.error(`  [${label}] ${i + 1}/${pairs.length} ❌ (tutti saltati o falliti)`);
      }

      await sleep(1000);
    } catch (e) {
      console.error(`  [${label}] coppia ${i + 1} errore imprevisto: ${e.message} — continuo`);
      await sleep(1000);
    }
  }

  const remaining = media.filter((m) => !sentUrls.has(m.url));
  if (remaining.length === 0) {
    clearProgress(progressKey);
    console.log(`🏁 ${label} completato!`);
  } else {
    console.warn(`⚠️ ${label}: ${remaining.length} media non inviati, riprendi con un nuovo avvio.`);
  }
}

// ─── Mirror canale + tutti i suoi thread / forum post ────────────────────────
async function mirrorChannel(sourceChannel, targetChannel, webhookUrl) {
  try {
    if (!webhookUrl) {
      console.error(`❌ Nessun webhook per #${targetChannel.name}, salto.`);
      return;
    }

    const label = `#${sourceChannel.name}`;

    // 1. Mirror messaggi principali del canale
    await mirrorMedia(label, sourceChannel, webhookUrl);

    // 2. Fetch tutti i thread / forum post del canale sorgente
    const sourceThreads = await scrapeThreads(sourceChannel);
    if (sourceThreads.length === 0) return;

    console.log(`🧵 ${label} → ${sourceThreads.length} thread/post trovati`);

    // Fetch thread già esistenti nel target per evitare duplicati
    const existingTargetThreads = new Map();
    try {
      const active = await targetChannel.threads.fetchActive().catch(() => ({ threads: { values: () => [] } }));
      for (const t of active.threads.values()) existingTargetThreads.set(t.name.toLowerCase(), t);
      const archived = await targetChannel.threads.fetchArchived({ limit: 100 }).catch(() => ({ threads: { values: () => [] } }));
      for (const t of archived.threads.values()) existingTargetThreads.set(t.name.toLowerCase(), t);
    } catch (e) {
      console.warn(`⚠️ Errore fetch thread target: ${e.message}`);
    }

    // Mirror ogni thread in sequenza
    for (const srcThread of sourceThreads) {
      try {
        let targetThread = existingTargetThreads.get(srcThread.name.toLowerCase());
        if (!targetThread) {
          targetThread = await targetChannel.threads.create({
            name: srcThread.name,
            autoArchiveDuration: 1440,
          }).catch((e) => { console.warn(`⚠️ Impossibile creare thread "${srcThread.name}": ${e.message}`); return null; });
          if (targetThread) {
            existingTargetThreads.set(srcThread.name.toLowerCase(), targetThread);
            await sleep(600);
          }
        }

        if (!targetThread) continue;

        const threadLabel = `${label} 🧵 ${srcThread.name}`;
        await mirrorMedia(threadLabel, srcThread, webhookUrl, targetThread.id);

        await sleep(800);
      } catch (e) {
        console.error(`💥 Errore mirror thread "${srcThread.name}": ${e.message}`);
      }
    }
  } catch (e) {
    console.error(`💥 Errore fatale in mirrorChannel #${sourceChannel?.name}: ${e.message}`);
  }
}

// ─── Ricerca categoria ────────────────────────────────────────────────────────
async function findCategory(categoryId) {
  try {
    for (const guild of client.guilds.cache.values()) {
      await guild.channels.fetch();
      const category = guild.channels.cache.get(categoryId);
      if (category) {
        const channels = guild.channels.cache
          .filter((ch) => ch.parentId === categoryId && (ch.isText() || ch.type === "GUILD_FORUM"))
          .sort((a, b) => a.position - b.position)
          .toJSON();
        console.log(`📌 "${category.name}" in "${guild.name}" → ${channels.length} canali`);
        return { guild, category, channels };
      }
    }
  } catch (e) {
    console.error(`❌ Errore findCategory: ${e.message}`);
  }
  return null;
}

// ─── Trova un thread/channel per ID ──────────────────────────────────────────
async function findChannelById(id) {
  try {
    return await client.channels.fetch(id);
  } catch (e) {
    console.error(`❌ Impossibile trovare canale/thread ${id}: ${e.message}`);
    return null;
  }
}

// ─── Modalità thread: clona SOURCE_THREAD → TARGET_THREAD ────────────────────
async function runThreadMode() {
  console.log(`\n🧵 Modalità THREAD: ${SOURCE_THREAD_ID} → ${TARGET_THREAD_ID}`);

  const sourceThread = await findChannelById(SOURCE_THREAD_ID);
  const targetThread = await findChannelById(TARGET_THREAD_ID);

  if (!sourceThread) { console.error(`❌ Thread sorgente non trovato!`); process.exit(1); }
  if (!targetThread) { console.error(`❌ Thread target non trovato!`);   process.exit(1); }

  console.log(`✅ Sorgente: "${sourceThread.name}" | Target: "${targetThread.name}"`);

  // Crea un webhook nel canale padre del thread target
  const parentId = targetThread.parentId ?? targetThread.id;
  const webhookUrl = await createWebhook(parentId);
  if (!webhookUrl) { console.error(`❌ Webhook fallito, impossibile continuare.`); process.exit(1); }

  const globalStart = Date.now();
  await mirrorMedia(`🧵 ${sourceThread.name}`, sourceThread, webhookUrl, targetThread.id);

  const totalMin = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log(`\n🎯 Thread completato in ${totalMin} minuti!`);
}

// ─── Modalità categoria: clona tutti i canali + thread ───────────────────────
async function runCategoryMode() {
  console.log(`\n📂 Modalità CATEGORIA: ${SOURCE_CATEGORY_ID} → ${TARGET_CATEGORY_ID}`);

  const source = await findCategory(SOURCE_CATEGORY_ID);
  const target = await findCategory(TARGET_CATEGORY_ID);

  if (!source) { console.error(`❌ Categoria sorgente non trovata!`); process.exit(1); }
  if (!target)  { console.error(`❌ Categoria target non trovata!`);   process.exit(1); }

  let targetChannels = target.channels;
  if (targetChannels.length === 0) {
    console.log(`\n⚙️ Target vuoto — creo i canali...`);
    for (const srcCh of source.channels) {
      const type = srcCh.type === "GUILD_FORUM" ? "GUILD_FORUM" : "GUILD_TEXT";
      const newCh = await createChannel(target.guild, srcCh.name, TARGET_CATEGORY_ID, type);
      if (newCh) targetChannels.push(newCh);
      await sleep(500);
    }
  }

  console.log(`\n📂 Sorgente: ${source.channels.length} | Target: ${targetChannels.length}`);

  const channelPairs = source.channels
    .map((src, i) => ({ source: src, target: targetChannels[i] }))
    .filter((p) => p.source && p.target);

  console.log(`🔗 Coppie di canali: ${channelPairs.length}`);

  console.log(`\n🔨 Pre-creazione webhook in sequenza...`);
  const pairsWithWebhooks = await createAllWebhooks(channelPairs);
  const okCount = pairsWithWebhooks.filter((p) => p.webhookUrl).length;
  console.log(`✅ Webhook pronti: ${okCount}/${pairsWithWebhooks.length}\n`);

  const globalStart = Date.now();

  await Promise.allSettled(
    pairsWithWebhooks.map(({ source, target, webhookUrl }) =>
      mirrorChannel(source, target, webhookUrl)
    )
  );

  const totalMin = ((Date.now() - globalStart) / 60000).toFixed(1);
  console.log(`\n🎯 Tutti i canali completati in ${totalMin} minuti!`);
}

// ─── Clone server: ruoli ─────────────────────────────────────────────────────
async function cloneRoles(sourceGuild, targetGuildId) {
  console.log(`\n🎭 Clonazione ruoli...`);

  const sourceRoles = sourceGuild.roles.cache
    .filter((r) => r.name !== "@everyone")
    .sort((a, b) => a.position - b.position)
    .toJSON();

  const targetRoles = await rest("GET", `/guilds/${targetGuildId}/roles`);
  const existingNames = new Map(targetRoles?.map((r) => [r.name.toLowerCase(), r.id]) ?? []);

  const roleMap = new Map();
  const everyoneSrc = sourceGuild.roles.cache.find((r) => r.name === "@everyone");
  const everyoneTgt = targetRoles?.find((r) => r.name === "@everyone");
  if (everyoneSrc && everyoneTgt) roleMap.set(everyoneSrc.id, everyoneTgt.id);

  for (const role of sourceRoles) {
    if (existingNames.has(role.name.toLowerCase())) {
      roleMap.set(role.id, existingNames.get(role.name.toLowerCase()));
      console.log(`  ↩ Già esistente: "${role.name}"`);
      continue;
    }
    const created = await rest("POST", `/guilds/${targetGuildId}/roles`, {
      name:        role.name,
      color:       role.color,
      hoist:       role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
    });
    if (created) {
      roleMap.set(role.id, created.id);
      console.log(`  ✅ "${role.name}"`);
    } else {
      console.error(`  ❌ Impossibile creare: "${role.name}"`);
    }
    await sleep(400);
  }

  // Applica gerarchia in un unico PATCH
  const positions = sourceRoles
    .map((r, idx) => ({ id: roleMap.get(r.id), position: idx + 1 }))
    .filter((r) => r.id);
  if (positions.length > 0) {
    await rest("PATCH", `/guilds/${targetGuildId}/roles`, positions);
    console.log(`  📐 Gerarchia applicata (${positions.length} ruoli)`);
  }

  return roleMap;
}

// ─── Clone server: converti permission overwrites ─────────────────────────────
function convertOverwrites(overwrites, roleMap) {
  return overwrites.cache
    .map((ow) => {
      const isRole = ow.type === "role" || ow.type === 0;
      const targetId = isRole ? roleMap.get(ow.id) : ow.id;
      if (isRole && !targetId) return null;
      return {
        id:    targetId,
        type:  isRole ? 0 : 1,
        allow: ow.allow.bitfield.toString(),
        deny:  ow.deny.bitfield.toString(),
      };
    })
    .filter(Boolean);
}

// ─── Clone server: singolo canale ────────────────────────────────────────────
async function cloneChannel(ch, targetGuildId, parentId, roleMap) {
  const TYPE_MAP = {
    GUILD_TEXT: 0, GUILD_VOICE: 2, GUILD_NEWS: 5,
    GUILD_FORUM: 15, GUILD_STAGE_VOICE: 13,
  };
  const type = TYPE_MAP[ch.type] ?? 0;
  const body = {
    name:                  ch.name,
    type,
    position:              ch.position,
    permission_overwrites: convertOverwrites(ch.permissionOverwrites, roleMap),
    ...(parentId               && { parent_id: parentId }),
    ...(ch.topic               && { topic: ch.topic }),
    ...(ch.nsfw                && { nsfw: ch.nsfw }),
    ...(ch.rateLimitPerUser    && { rate_limit_per_user: ch.rateLimitPerUser }),
    ...(type === 2             && { bitrate: ch.bitrate, user_limit: ch.userLimit }),
  };
  const created = await rest("POST", `/guilds/${targetGuildId}/channels`, body);
  const icon = type === 2 ? "🔊" : type === 5 ? "📢" : type === 15 ? "💬" : "#";
  if (created) console.log(`    ${icon} "${ch.name}"`);
  else         console.error(`    ❌ Impossibile creare: "${ch.name}"`);
  return created;
}

// ─── Clone server: categorie + canali ────────────────────────────────────────
async function cloneChannelsAndCategories(sourceGuild, targetGuildId, roleMap) {
  console.log(`\n📁 Clonazione categorie e canali...`);
  await sourceGuild.channels.fetch();

  const categories = sourceGuild.channels.cache
    .filter((c) => c.type === "GUILD_CATEGORY")
    .sort((a, b) => a.position - b.position)
    .toJSON();

  const orphans = sourceGuild.channels.cache
    .filter((c) => c.type !== "GUILD_CATEGORY" && !c.parentId)
    .sort((a, b) => a.position - b.position)
    .toJSON();

  for (const cat of categories) {
    const created = await rest("POST", `/guilds/${targetGuildId}/channels`, {
      name:                  cat.name,
      type:                  4,
      position:              cat.position,
      permission_overwrites: convertOverwrites(cat.permissionOverwrites, roleMap),
    });
    if (created) console.log(`  📂 "${cat.name}"`);
    else { console.error(`  ❌ Categoria: "${cat.name}"`); await sleep(400); continue; }
    await sleep(400);

    const children = sourceGuild.channels.cache
      .filter((c) => c.parentId === cat.id)
      .sort((a, b) => a.position - b.position)
      .toJSON();

    for (const ch of children) {
      await cloneChannel(ch, targetGuildId, created.id, roleMap);
      await sleep(400);
    }
  }

  for (const ch of orphans) {
    await cloneChannel(ch, targetGuildId, null, roleMap);
    await sleep(400);
  }
}

// ─── REST helper con retry 429 ────────────────────────────────────────────────
async function rest(method, path, body = null, retries = 6) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios({
        method,
        url: `https://discord.com/api/v10${path}`,
        data: body,
        headers: { Authorization: TOKEN, "Content-Type": "application/json" },
        validateStatus: () => true,
      });
      if (res.status === 429) {
        const wait = (res.data?.retry_after ?? 3) + 0.5;
        console.warn(`  ⏳ Rate limit ${path} — aspetto ${wait}s`);
        await sleep(wait * 1000);
        continue;
      }
      if (res.status >= 200 && res.status < 300) return res.data;
      console.warn(`  ⚠️ ${method} ${path} → ${res.status}`);
      await sleep(1500 * (i + 1));
    } catch (e) {
      console.error(`  ❌ REST error: ${e.message}`);
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

// ─── Modalità clone server ────────────────────────────────────────────────────
async function runCloneMode() {
  console.log(`\n🖨️  Modalità CLONE SERVER: ${SOURCE_GUILD_ID} → ${TARGET_GUILD_ID}`);

  const sourceGuild = await client.guilds.fetch(SOURCE_GUILD_ID);
  await sourceGuild.roles.fetch();
  await sourceGuild.channels.fetch();
  console.log(`✅ Sorgente: "${sourceGuild.name}"`);

  const targetInfo = await rest("GET", `/guilds/${TARGET_GUILD_ID}`);
  if (!targetInfo) { console.error(`❌ Guild target non trovata!`); process.exit(1); }
  console.log(`✅ Target:   "${targetInfo.name}"`);

  const roleMap = await cloneRoles(sourceGuild, TARGET_GUILD_ID);
  console.log(`✅ Ruoli clonati: ${roleMap.size}`);

  await cloneChannelsAndCategories(sourceGuild, TARGET_GUILD_ID, roleMap);
}

// ─── Entry point ──────────────────────────────────────────────────────────────
client.on("ready", async () => {
  try {
    console.log(`\n🤖 Loggato come ${client.user.tag}`);

    if (SOURCE_GUILD_ID && TARGET_GUILD_ID) {
      const start = Date.now();
      await runCloneMode();
      console.log(`\n🎯 Clone completato in ${((Date.now()-start)/1000).toFixed(1)}s!`);
    } else if (SOURCE_THREAD_ID && TARGET_THREAD_ID) {
      await runThreadMode();
    } else if (SOURCE_CATEGORY_ID && TARGET_CATEGORY_ID) {
      await runCategoryMode();
    } else {
      console.error([
        `❌ Configura almeno una modalità nel .env:`,
        `   Clone server: SOURCE_GUILD_ID + TARGET_GUILD_ID`,
        `   Thread:       SOURCE_THREAD_ID + TARGET_THREAD_ID`,
        `   Categoria:    SOURCE_CATEGORY_ID + TARGET_CATEGORY_ID`,
      ].join("\n"));
      process.exit(1);
    }

    process.exit(0);
  } catch (e) {
    console.error(`💥 Errore nel ready handler: ${e.message}`);
    process.exit(1);
  }
});

client.login(TOKEN).catch((e) => {
  console.error(`❌ Login fallito: ${e.message}`);
  process.exit(1);
});
