import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

dotenv.config();

const exec = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const DATA = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA, 'db.json');
const RAW = path.join(DATA, 'raw');
const RENDERED = path.join(DATA, 'rendered');

const PORT = Number(process.env.PORT || 10000);

await fs.mkdir(RAW, { recursive: true });
await fs.mkdir(RENDERED, { recursive: true });

async function loadDb() {
  try {
    return JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch {
    return {
      accounts: [],
      reels: [],
      batches: [],
      jobs: []
    };
  }
}

async function saveDb(db) {
  await fs.writeFile(
    DB_FILE,
    JSON.stringify(db, null, 2)
  );
}

function id(prefix = 'id') {
  return `${prefix}_${crypto.randomUUID()}`;
}

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function shuffle(array) {
  const x = [...array];

  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }

  return x;
}

const app = express();

app.use(
  express.json({
    limit: '2mb'
  })
);

app.use(
  cors({
    origin: process.env.ALLOWED_ORIGIN || true
  })
);

app.use(
  '/media',
  express.static(RENDERED)
);


/* =========================
   HEALTH
========================= */

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    version: '1.1'
  });
});


/* =========================
   ACCOUNTS
========================= */

app.get('/api/accounts', async (_req, res) => {
  const db = await loadDb();
  res.json(db.accounts);
});


app.post('/api/accounts', async (req, res) => {
  const username = cleanUsername(req.body.username);
  const category = req.body.category;

  if (
    !username ||
    !['meme', 'movie_tv', 'music'].includes(category)
  ) {
    return res.status(400).json({
      error: 'username and valid category are required'
    });
  }

  const db = await loadDb();

  let account = db.accounts.find(
    x => x.username === username
  );

  if (account) {
    account.category = category;
    account.active = true;

    await saveDb(db);

    return res.json(account);
  }

  account = {
    id: id('acct'),
    username,
    category,
    active: true,
    createdAt: new Date().toISOString(),
    lastSyncAt: null
  };

  db.accounts.push(account);

  await saveDb(db);

  res.json(account);
});


/* =========================
   APIFY
========================= */

async function apifyActor(input) {
  if (!process.env.APIFY_TOKEN) {
    throw new Error(
      'APIFY_TOKEN is not configured on the server'
    );
  }

  const actor =
    'instagram-scraper~instagram-profile-reels-scraper';

  const url =
    `https://api.apify.com/v2/acts/${actor}/runs` +
    `?token=${encodeURIComponent(process.env.APIFY_TOKEN)}` +
    `&waitForFinish=120`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json'
    },
    body: JSON.stringify(input)
  });

  if (!response.ok) {
    throw new Error(
      `Apify start failed: ${response.status}`
    );
  }

  const run = await response.json();

  const datasetId =
    run?.data?.defaultDatasetId;

  if (!datasetId) {
    throw new Error(
      'Apify did not return a dataset'
    );
  }

  const datasetResponse = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items` +
    `?token=${encodeURIComponent(process.env.APIFY_TOKEN)}` +
    `&clean=true`
  );

  if (!datasetResponse.ok) {
    throw new Error(
      `Apify dataset failed: ${datasetResponse.status}`
    );
  }

  return await datasetResponse.json();
}


/* =========================
   SYNC INSTAGRAM
========================= */

app.post(
  '/api/accounts/:id/sync',
  async (req, res) => {

    const db = await loadDb();

    const account = db.accounts.find(
      x => x.id === req.params.id
    );

    if (!account) {
      return res.status(404).json({
        error: 'account not found'
      });
    }

    try {

      const items = await apifyActor({
        instagramUsernames: [
          account.username
        ],
        resultsLimit: 100
      });

      let added = 0;

      for (const item of items) {

        const reelId = String(
          item.id ||
          item.shortCode ||
          item.url ||
          item.pk ||
          ''
        );

        if (!reelId) continue;

        const videoUrl =
          item.videoUrl ||
          item.video_url ||
          item.mediaUrl ||
          item.media_url ||
          item.downloadUrl ||
          item.download_url ||
          '';

        if (!videoUrl) continue;

        const previewUrl =
          item.thumbnailUrl ||
          item.thumbnail_url ||
          item.displayUrl ||
          item.display_url ||
          item.imageUrl ||
          item.image_url ||
          '';

        const permalink =
          item.url ||
          item.permalink ||
          item.reelUrl ||
          item.reel_url ||
          '';

        const existing = db.reels.find(
          r => r.id === reelId
        );

        if (existing) {
          existing.videoUrl = videoUrl;

          if (previewUrl) {
            existing.previewUrl = previewUrl;
          }

          if (permalink) {
            existing.permalink = permalink;
          }

          continue;
        }

        db.reels.push({
          id: reelId,
          sourceId: account.id,
          username: account.username,
          category: account.category,
          permalink,
          videoUrl,
          previewUrl,
          caption: item.caption || '',
          used: false,
          reserved: false,
          createdAt:
            item.timestamp ||
            new Date().toISOString()
        });

        added++;
      }

      account.lastSyncAt =
        new Date().toISOString();

      await saveDb(db);

      const accountReels =
        db.reels.filter(
          r => r.sourceId === account.id
        );

      res.json({
        account,
        added,
        total: accountReels.length,
        reels: accountReels
      });

    } catch (error) {

      res.status(502).json({
        error: error.message
      });

    }
  }
);


/* =========================
   REELS
========================= */

app.get('/api/reels', async (req, res) => {

  const db = await loadDb();

  let reels = db.reels;

  if (req.query.accountId) {
    reels = reels.filter(
      r => r.sourceId === req.query.accountId
    );
  }

  if (req.query.unused === 'true') {
    reels = reels.filter(
      r => !r.used && !r.reserved
    );
  }

  res.json(reels);
});


/* =========================
   RANDOM BATCH
========================= */

app.post('/api/batch/random', async (_req, res) => {

  const db = await loadDb();

  const pool = db.reels.filter(
    r => !r.used && !r.reserved
  );

  const chosen = shuffle(pool).slice(0, 10);

  if (chosen.length < 10) {
    return res.status(409).json({
      error:
        `Only ${chosen.length} unused Reels are available; need 10.`
    });
  }

  const batch = {
    id: id('batch'),
    createdAt: new Date().toISOString(),
    count: chosen.length,
    status: 'selected'
  };

  for (const reel of chosen) {
    reel.reserved = true;
  }

  const jobs = chosen.map(reel => ({
    id: id('job'),
    batchId: batch.id,
    reelId: reel.id,
    status: 'selected',
    hook: '',
    caption: reel.caption || '',
    outputUrl: null,
    error: null
  }));

  db.batches.push(batch);
  db.jobs.push(...jobs);

  await saveDb(db);

  res.json({
    batch,
    jobs,
    reels: chosen
  });
});


/* =========================
   DOWNLOAD VIDEO
========================= */

async function download(url, output) {

  const response = await fetch(
    url,
    {
      redirect: 'follow'
    }
  );

  if (!response.ok) {
    throw new Error(
      `Video download failed: ${response.status}`
    );
  }

  const buffer = Buffer.from(
    await response.arrayBuffer()
  );

  if (buffer.length < 1000) {
    throw new Error(
      'Downloaded video is too small'
    );
  }

  await fs.writeFile(
    output,
    buffer
  );
}


/* =========================
   FFMPEG RENDER
========================= */

async function renderVideo(
  input,
  output,
  hook
) {

  const safe = String(hook || '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/:/g, '\\:')
    .replace(/%/g, '\\%');

  const vf =
    `scale=1280:720:force_original_aspect_ratio=decrease,` +
    `pad=1280:720:(ow-iw)/2:(oh-ih)/2,` +
    `drawtext=` +
    `fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:` +
    `text='${safe}':` +
    `fontcolor=white:` +
    `fontsize=46:` +
    `borderw=3:` +
    `bordercolor=black:` +
    `x=(w-text_w)/2:` +
    `y=34`;

  await exec(
    'ffmpeg',
    [
      '-y',
      '-i',
      input,
      '-vf',
      vf,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '22',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      output
    ],
    {
      maxBuffer: 1024 * 1024 * 10
    }
  );
}

/* =========================
   AI CONTENT ANALYSIS
========================= */

async function extractFrames(videoPath, prefix) {
  const pattern = path.join(
    RAW,
    `${prefix}_%02d.jpg`
  );

  await exec(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      'fps=1/3,scale=640:-1',
      '-frames:v',
      '6',
      pattern
    ],
    {
      maxBuffer: 1024 * 1024 * 10
    }
  );

  const files = (
    await fs.readdir(RAW)
  )
    .filter(
      name =>
        name.startsWith(`${prefix}_`) &&
        name.endsWith('.jpg')
    )
    .sort();

  return files.map(
    name =>
      path.join(RAW, name)
  );
}


async function analyzeWithOpenRouter(
  framePaths,
  style
) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured on the server'
    );
  }

  const content = [
    {
      type: 'text',
      text: `
You are the content analyst for a viral Instagram Reels remix tool.

Analyze the supplied video frames together.

Your job:
1. Understand what is actually happening in the video.
2. Identify the main situation, joke, reaction, conflict,
   surprising moment or emotional beat.
3. Do NOT invent events that are not visible.
4. Do NOT create generic hooks that could fit any video.
5. Create 5 short viral Instagram Reel hooks.
6. Every hook MUST clearly relate to the specific video.
7. Hooks should feel natural for Gen Z / millennial social media.
8. Avoid explaining the entire video.
9. Keep each hook under 12 words.
10. Style: ${style}

Return ONLY valid JSON in exactly this format:

{
  "summary": "short description of what happens",
  "hooks": [
    "hook 1",
    "hook 2",
    "hook 3",
    "hook 4",
    "hook 5"
  ],
  "caption": "short Instagram caption"
}
      `.trim()
    }
  ];

  for (const framePath of framePaths) {
    const base64 =
      (
        await fs.readFile(
          framePath
        )
      ).toString('base64');

    content.push({
      type: 'image_url',
      image_url: {
        url:
          `data:image/jpeg;base64,${base64}`
      }
    });
  }

  const response = await fetch(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type':
          'application/json',
        'HTTP-Referer':
          'https://squin1983.github.io/Clipper/',
        'X-Title':
          'Clipper'
      },
      body: JSON.stringify({
        model: 'openrouter/free',
        messages: [
          {
            role: 'user',
            content
          }
        ],
        temperature: 0.8,
        max_tokens: 700
      })
    }
  );

  const data =
    await response.json();

  if (!response.ok) {
    throw new Error(
      data?.error?.message ||
      `OpenRouter failed: ${response.status}`
    );
  }

  const text =
    data?.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error(
      'OpenRouter returned no analysis'
    );
  }

  const cleaned =
    String(text)
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

  let result;

  try {
    result = JSON.parse(cleaned);
  } catch {
    throw new Error(
      'AI returned invalid JSON'
    );
  }

  if (
    !result.summary ||
    !Array.isArray(result.hooks) ||
    !result.hooks.length
  ) {
    throw new Error(
      'AI returned incomplete analysis'
    );
  }

  return {
    summary:
      String(result.summary),
    hooks:
      result.hooks
        .map(x => String(x).trim())
        .filter(Boolean)
        .slice(0, 5),
    caption:
      String(
        result.caption || ''
      ).trim()
  };
}


app.post(
  '/api/reels/:id/analyze',
  async (req, res) => {
    const db =
      await loadDb();

    const reel =
      db.reels.find(
        x =>
          x.id === req.params.id
      );

    if (!reel) {
      return res.status(404).json({
        error: 'reel not found'
      });
    }

    if (!reel.videoUrl) {
      return res.status(400).json({
        error:
          'reel has no video URL'
      });
    }

    const style =
      String(
        req.body?.style ||
        'Relatable'
      );

    const prefix =
      `analysis_${crypto.randomUUID()}`;

    const videoPath =
      path.join(
        RAW,
        `${prefix}.mp4`
      );

    let framePaths = [];

    try {
      await download(
        reel.videoUrl,
        videoPath
      );

      framePaths =
        await extractFrames(
          videoPath,
          prefix
        );

      if (!framePaths.length) {
        throw new Error(
          'Could not extract video frames'
        );
      }

      const result =
        await analyzeWithOpenRouter(
          framePaths,
          style
        );

      res.json({
        reelId: reel.id,
        ...result
      });

    } catch (error) {

      res.status(500).json({
        error:
          error.message
      });

    } finally {

      await fs.rm(
        videoPath,
        {
          force: true
        }
      ).catch(() => {});

      for (
        const framePath
        of framePaths
      ) {
        await fs.rm(
          framePath,
          {
            force: true
          }
        ).catch(() => {});
      }
    }
  }
);
/* =========================
   RENDER JOB
========================= */

app.post(
  '/api/jobs/:id/render',
  async (req, res) => {

    const db = await loadDb();

    const job = db.jobs.find(
      x => x.id === req.params.id
    );

    if (!job) {
      return res.status(404).json({
        error: 'job not found'
      });
    }

    const reel = db.reels.find(
      x => x.id === job.reelId
    );

    if (!reel) {
      return res.status(404).json({
        error: 'reel not found'
      });
    }

    job.status = 'rendering';

    job.hook = String(
      req.body.hook || ''
    );

    job.caption = String(
      req.body.caption ??
      reel.caption ??
      ''
    );

    await saveDb(db);

    try {

      const base = job.id;

      const input =
        path.join(
          RAW,
          `${base}.mp4`
        );

      const output =
        path.join(
          RENDERED,
          `${base}.mp4`
        );

      await download(
        reel.videoUrl,
        input
      );

      await renderVideo(
        input,
        output,
        job.hook
      );

      job.status = 'ready';

      job.outputUrl =
        `/media/${base}.mp4`;

      job.error = null;

      reel.reserved = false;
      reel.used = true;

      await saveDb(db);

      res.json(job);

    } catch (error) {

      job.status = 'error';
      job.error = error.message;

      reel.reserved = false;

      await saveDb(db);

      res.status(500).json({
        error: error.message,
        job
      });
    }
  }
);


/* =========================
   JOB
========================= */

app.get(
  '/api/jobs/:id',
  async (req, res) => {

    const db = await loadDb();

    const job = db.jobs.find(
      x => x.id === req.params.id
    );

    if (!job) {
      return res.status(404).json({
        error: 'job not found'
      });
    }

    res.json(job);
  }
);


/* =========================
   ALL BATCHES
========================= */

app.get('/api/batches', async (_req, res) => {

  const db = await loadDb();

  const result =
    db.batches
      .slice()
      .reverse()
      .map(batch => {

        const jobs =
          db.jobs.filter(
            job => job.batchId === batch.id
          );

        const reels =
          jobs
            .map(job =>
              db.reels.find(
                reel => reel.id === job.reelId
              )
            )
            .filter(Boolean);

        return {
          batch,
          jobs,
          reels
        };
      });

  res.json(result);
});


/* =========================
   SINGLE BATCH
========================= */

app.get(
  '/api/batches/:id',
  async (req, res) => {

    const db = await loadDb();

    const batch = db.batches.find(
      x => x.id === req.params.id
    );

    if (!batch) {
      return res.status(404).json({
        error: 'batch not found'
      });
    }

    const jobs =
      db.jobs.filter(
        job => job.batchId === batch.id
      );

    const reels =
      jobs
        .map(job =>
          db.reels.find(
            reel => reel.id === job.reelId
          )
        )
        .filter(Boolean);

    res.json({
      batch,
      jobs,
      reels
    });
  }
);


/* =========================
   START
========================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Clipper backend listening on ${PORT}`
    );
  }
);
