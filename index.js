require("dotenv").config();
const { Client } = require("discord.js-selfbot-v13");
const axios = require("axios");
const fs = require("fs");
const FormData = require("form-data");

const TOKEN = process.env.DISCORD_TOKEN;
const SOURCE_CATEGORY_ID = process.env.SOURCE_CATEGORY_ID?.trim();
const TARGET_CATEGORY_ID = process.env.TARGET_CATEGORY_ID?.trim();

const INVISIBLE_AVATAR =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const VIDEO_EXTENSIONS = [".mp4", ".mov", ".avi", ".mkv", ".webm"];

// Discord webhook file size limit (25 MB per request for non-boosted servers)
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const client = new Client({ checkUpdate: false });

process.on("uncaughtException",  (err) => console.error(`💥 uncaughtException: ${err?.stack || err}`));
process.on("unhandledRejection", (r)   => console.error(`💥 unhandledRejection: ${r?.stack || r}`));

// ─── Utility ─────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Progresso ────────────────────────────────────────────────────────────────
function saveProgress(channelId, sentUrls) {
  try {
    fs.writeFileSync(`progress_${channelId}.json`, JSON.stringify({ sent_urls: [...sentUrls] }));
  } catch (e) {
    console.error(`❌ Errore salvataggio progresso: ${e.message}`);
  }
}

function loadProgress(channelId) {
  try {
    const file = `progress_${channelId}.json`;
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

// ─── Canali ───────────────────────────────────────────────────────────────────
async function createChannel(guild, name, categoryId) {
  try {
    const ch = await guild.channels.create(name, { type: "GUILD_TEXT", parent: categoryId });
    console.log(`✅ Canale creato: #${ch.name}`);
    return ch;
  } catch (e) {
    console.error(`❌ Errore creazione canale ${name}: ${e.message}`);
    return null;
  }
}

// ─── Webhook con retry su 429 ──────────────────────────────────────────────
// FIX: gestisce il 429 con backoff invece di fallire subito
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
        // FIX: rispetta il retry_after di Discord invece di fallire
        const retryAfter = (res.data?.retry_after ?? 5) + 1;
        console.warn(`  ⏳ Webhook 429 (canale ${channelId}) — aspetto ${retryAfter.toFixed(1)}s (tentativo ${attempt + 1}/${retries})`);
        await sleep(retryAfter * 1000);
        continue;
      }

      if (res.status === 200 || res.status === 201) {
        const { id, token } = res.data;
        console.log(`✅ Webhook creato nel canale ${channelId}`);
        return `https://discord.com/api/webhooks/${id}/${token}`;
      }

      console.warn(`  ⚠️ Webhook status ${res.status} per canale ${channelId} — ritento (${attempt + 1}/${retries})`);
      await sleep(2000 * (attempt + 1));
    } catch (e) {
      console.error(`❌ Errore webhook: ${e.message} — ritento (${attempt + 1}/${retries})`);
      await sleep(2000 * (attempt + 1));
    }
  }
  console.error(`❌ Webhook fallito definitivamente per canale ${channelId}`);
  return null;
}

// ─── Pre-crea tutti i webhook in sequenza ─────────────────────────────────────
// FIX: invece di creare tutti in parallelo (→ burst di 429),
//      li crea uno alla volta con una piccola pausa tra l'uno e l'altro.
async function createAllWebhooks(channelPairs) {
  const result = [];
  for (const pair of channelPairs) {
    const webhookUrl = await createWebhook(pair.target.id);
    result.push({ ...pair, webhookUrl });
    if (result.length < channelPairs.length) await sleep(800); // pausa anti-rate-limit
  }
  return result;
}

// ─── Download singolo video con refresh URL Discord ───────────────────────────
async function downloadVideo(video, channel, retries = 5) {
  let { url, ext, messageId } = video;

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
            const freshAtt = [...msg.attachments.values()].find((a) =>
              VIDEO_EXTENSIONS.some((e) => a.name?.toLowerCase().endsWith(e))
            );
            if (freshAtt) { url = freshAtt.url; video.url = url; continue; }
            const freshEmbed = msg.embeds.find((em) => em.video?.url);
            if (freshEmbed) { url = freshEmbed.video.url; video.url = url; continue; }
          } catch (fetchErr) {
            console.warn(`  ⚠️ Impossibile ri-fetchare messaggio: ${fetchErr.message}`);
          }
        }
        return null;
      }

      if (res.status !== 200) {
        await sleep(2000 * (attempt + 1));
        continue;
      }

      const buffer = Buffer.from(res.data);

      // FIX: controlla la dimensione prima di restituire il buffer.
      // Se supera il limite Discord non potrà mai essere caricato → scarta subito.
      if (buffer.length > MAX_UPLOAD_BYTES) {
        console.warn(`  ⚠️ File troppo grande (${(buffer.length / 1024 / 1024).toFixed(1)} MB > 25 MB), saltato: ${url}`);
        return null;
      }

      return { buffer, filename: `SENSATIONAL_TEMP${ext}`, url };
    } catch (e) {
      console.warn(`  ⚠️ Download fallito (${attempt + 1}/${retries}): ${e.message}`);
      if (attempt < retries - 1) await sleep(2000 * (attempt + 1));
    }
  }
  console.error(`  ❌ Download fallito definitivamente: ${url}`);
  return null;
}

// ─── Download PARALLELO di una coppia ────────────────────────────────────────
async function downloadPair(pair, channel) {
  const results = await Promise.all(pair.map((video) => downloadVideo(video, channel)));
  const files = [];
  results.forEach((result, i) => {
    if (!result) {
      console.warn(`  ⚠️ Video ${i + 1} non scaricabile — verrà saltato.`);
      return;
    }
    const filename = `SENSATIONAL${pair.length > 1 ? `_${i + 1}` : ""}${pair[i].ext}`;
    files.push({ buffer: result.buffer, filename, url: result.url });
  });
  return files;
}

// ─── Invio file via webhook ────────────────────────────────────────────────────
// FIX principale: se arriva un 413 non ha senso riprovare con lo stesso payload.
//   → si spezza la coppia e si invia ogni file singolarmente.
async function sendSingleFile(webhookUrl, file, retries = 5) {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ username: "SENSATIONAL" }));
      form.append("files[0]", file.buffer, { filename: file.filename, contentType: "video/mp4" });

      const res = await axios.post(webhookUrl, form, {
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
        // Non ritentare — il file è intrinsecamente troppo grande (non dovrebbe mai arrivare qui
        // grazie al controllo in downloadVideo, ma per sicurezza)
        console.warn(`  ⚠️ File troppo grande per Discord (413), saltato: ${file.filename}`);
        return null;
      }
      if (res.status === 200 || res.status === 204) {
        return file.url;
      }

      console.warn(`  ⚠️ Status ${res.status} — ritento (${attempt + 1}/${retries})`);
      await sleep(3000 * (attempt + 1));
    } catch (e) {
      console.error(`  ❌ Errore invio: ${e.message} — ritento (${attempt + 1}/${retries})`);
      await sleep(4000 * (attempt + 1));
    }
  }
  return null;
}

async function sendFiles(webhookUrl, files) {
  if (files.length === 0) return [];

  // FIX: controlla se la dimensione totale supera il limite.
  // In caso, invia ogni file separatamente invece che insieme.
  const totalSize = files.reduce((sum, f) => sum + f.buffer.length, 0);
  const sentUrls = [];

  if (files.length === 1 || totalSize <= MAX_UPLOAD_BYTES) {
    // Prova a inviare tutto insieme
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        const form = new FormData();
        form.append("payload_json", JSON.stringify({ username: "SENSATIONAL" }));
        files.forEach(({ buffer, filename }, i) => {
          form.append(`files[${i}]`, buffer, { filename, contentType: "video/mp4" });
        });

        const res = await axios.post(webhookUrl, form, {
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
          // FIX: payload troppo grande → riprova file per file
          console.warn(`  ⚠️ 413 sul batch — invio file uno per uno`);
          break; // esce dal loop e va alla logica singola sotto
        }
        if (res.status === 200 || res.status === 204) {
          return files.map((f) => f.url);
        }

        console.warn(`  ⚠️ Status ${res.status} — ritento (${attempt + 1}/5)`);
        await sleep(3000 * (attempt + 1));
      } catch (e) {
        console.error(`  ❌ Errore invio batch: ${e.message} — ritento (${attempt + 1}/5)`);
        await sleep(4000 * (attempt + 1));
      }
    }
  }

  // FIX: invio file per file (fallback 413 o payload troppo grande)
  for (const file of files) {
    const url = await sendSingleFile(webhookUrl, file);
    if (url) {
      sentUrls.push(url);
      await sleep(500); // piccola pausa tra un file e l'altro
    }
  }
  return sentUrls;
}

// ─── Mirror con PIPELINE ──────────────────────────────────────────────────────
async function mirrorChannel(sourceChannel, targetChannel, webhookUrl) {
  try {
    if (!webhookUrl) {
      console.error(`❌ Nessun webhook per #${targetChannel.name}, salto.`);
      return;
    }

    const videos = await scrapeChannel(sourceChannel);
    if (videos.length === 0) {
      console.log(`⚠️ Nessun video in #${sourceChannel.name}, salto.`);
      return;
    }

    const sentUrls = loadProgress(sourceChannel.id);
    const pending = videos.filter((v) => !sentUrls.has(v.url));
    console.log(`▶ #${sourceChannel.name} — ${sentUrls.size} già inviati, ${pending.length} rimanenti su ${videos.length} totali`);

    if (pending.length === 0) {
      console.log(`✅ #${sourceChannel.name} già completato.`);
      return;
    }

    const pairs = [];
    for (let i = 0; i < pending.length; i += 2) pairs.push(pending.slice(i, i + 2));

    const startTime = Date.now();

    // PIPELINE: avvia subito il download della prima coppia
    let nextFilesPromise = downloadPair(pairs[0], sourceChannel);

    for (let i = 0; i < pairs.length; i++) {
      try {
        const files = await nextFilesPromise;

        // PIPELINE: avvia il download della coppia successiva mentre si invia questa
        if (i + 1 < pairs.length) {
          nextFilesPromise = downloadPair(pairs[i + 1], sourceChannel);
        }

        const sentNow = await sendFiles(webhookUrl, files);

        if (sentNow.length > 0) {
          sentNow.forEach((url) => sentUrls.add(url));
          saveProgress(sourceChannel.id, sentUrls);

          const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
          const rate = ((i + 1) / elapsed * 60).toFixed(1);
          console.log(`  [#${sourceChannel.name}] ${i + 1}/${pairs.length} ✅  (${elapsed}s — ~${rate} coppie/min)`);
        } else {
          console.error(`  [#${sourceChannel.name}] ${i + 1}/${pairs.length} ❌ (tutti i file saltati o falliti)`);
        }

        await sleep(1000);
      } catch (e) {
        console.error(`  [#${sourceChannel.name}] coppia ${i + 1} errore imprevisto: ${e.message} — continuo`);
        await sleep(1000);
      }
    }

    const remaining = videos.filter((v) => !sentUrls.has(v.url));
    if (remaining.length === 0) {
      try {
        const file = `progress_${sourceChannel.id}.json`;
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch (_) {}
      console.log(`🏁 #${sourceChannel.name} → #${targetChannel.name} completato!`);
    } else {
      console.warn(`⚠️ #${sourceChannel.name}: ${remaining.length} video non inviati, riprendi con un nuovo avvio.`);
    }
  } catch (e) {
    console.error(`💥 Errore fatale in mirrorChannel #${sourceChannel?.name}: ${e.message}`);
  }
}

// ─── Scraping ────────────────────────────────────────────────────────────────
async function scrapeChannel(channel) {
  const videos = [];
  const seen = new Set();
  console.log(`▶ Scraping #${channel.name}...`);
  let lastId = null;
  let stuckGuard = 0;

  while (true) {
    try {
      const options = { limit: 100 };
      if (lastId) options.before = lastId;

      const messages = await channel.messages.fetch(options);
      if (messages.size === 0) break;

      const newLastId = messages.last()?.id;
      if (newLastId === lastId) {
        if (++stuckGuard >= 3) { console.warn(`⚠️ Loop bloccato in #${channel.name}, esco.`); break; }
      } else { stuckGuard = 0; }
      lastId = newLastId;

      messages.forEach((msg) => {
        msg.attachments.forEach((att) => {
          const ext = VIDEO_EXTENSIONS.find((e) => att.name?.toLowerCase().endsWith(e));
          if (ext && !seen.has(att.url)) {
            seen.add(att.url);
            videos.push({ url: att.url, ext, messageId: msg.id });
          }
        });
        msg.embeds.forEach((embed) => {
          const videoUrl = embed.video?.url || embed.video?.proxyURL;
          if (videoUrl && !seen.has(videoUrl)) {
            const ext = VIDEO_EXTENSIONS.find((e) => videoUrl.toLowerCase().includes(e));
            if (ext) { seen.add(videoUrl); videos.push({ url: videoUrl, ext, messageId: msg.id }); }
          }
        });
      });

      await sleep(500);
    } catch (e) {
      console.error(`❌ Errore fetch messaggi in #${channel.name}: ${e.message} — riprovo tra 3s`);
      await sleep(3000);
    }
  }

  console.log(`✅ #${channel.name} → ${videos.length} video unici trovati`);
  return videos;
}

// ─── Ricerca categoria ────────────────────────────────────────────────────────
async function findCategory(categoryId) {
  try {
    for (const guild of client.guilds.cache.values()) {
      await guild.channels.fetch();
      const category = guild.channels.cache.get(categoryId);
      if (category) {
        const channels = guild.channels.cache
          .filter((ch) => ch.parentId === categoryId && ch.isText())
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

// ─── Entry point ──────────────────────────────────────────────────────────────
client.on("ready", async () => {
  try {
    console.log(`\n🤖 Loggato come ${client.user.tag}`);

    const source = await findCategory(SOURCE_CATEGORY_ID);
    const target = await findCategory(TARGET_CATEGORY_ID);

    if (!source) { console.error(`❌ Categoria sorgente non trovata!`); process.exit(1); }
    if (!target)  { console.error(`❌ Categoria target non trovata!`);   process.exit(1); }

    let targetChannels = target.channels;
    if (targetChannels.length === 0) {
      console.log(`\n⚙️ Target vuoto — creo i canali...`);
      for (const srcCh of source.channels) {
        const newCh = await createChannel(target.guild, srcCh.name, TARGET_CATEGORY_ID);
        if (newCh) targetChannels.push(newCh);
        await sleep(500);
      }
    }

    console.log(`\n📂 Sorgente: ${source.channels.length} | Target: ${targetChannels.length}`);

    const channelPairs = source.channels
      .map((src, i) => ({ source: src, target: targetChannels[i] }))
      .filter((p) => p.source && p.target);

    console.log(`🔗 Coppie di canali: ${channelPairs.length}`);

    // FIX: crea tutti i webhook in sequenza con pausa anti-rate-limit
    //      PRIMA di avviare il mirror parallelo dei canali.
    console.log(`\n🔨 Pre-creazione webhook in sequenza...`);
    const pairsWithWebhooks = await createAllWebhooks(channelPairs);

    const okCount = pairsWithWebhooks.filter((p) => p.webhookUrl).length;
    console.log(`✅ Webhook pronti: ${okCount}/${pairsWithWebhooks.length}\n`);

    const globalStart = Date.now();

    // I canali girano in parallelo — ogni canale usa il proprio webhook già creato
    await Promise.allSettled(
      pairsWithWebhooks.map(({ source, target, webhookUrl }) =>
        mirrorChannel(source, target, webhookUrl)
      )
    );

    const totalMin = ((Date.now() - globalStart) / 60000).toFixed(1);
    console.log(`\n🎯 Tutti i canali completati in ${totalMin} minuti!`);
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
