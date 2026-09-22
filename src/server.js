const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

dotenv.config();

const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const ROOT = '/tmp/clipper';
const RAW = path.join(ROOT, 'raw');
const OUTPUT = path.join(ROOT, 'output');
const DB_FILE = path.join(ROOT, 'db.json');

async function ensureStorage() {
  await fs.mkdir(RAW, { recursive: true });
  await fs.mkdir(OUTPUT, { recursive: true });

  try {
    await fs.access(DB_FILE);
  } catch {
    await fs.writeFile(
      DB_FILE,
      JSON.stringify(
        {
          accounts: [],
          reels: [],
          batches: [],
          jobs: []
        },
        null,
        2
      )
    );
  }
}

async function readDb() {
  await ensureStorage();
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await ensureStorage();
  await fs.writeFile(
    DB_FILE,
    JSON.stringify(db, null, 2)
  );
}

function normalizeUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .replace(/\/+$/, '');
}

function pickVideoUrl(item) {
  return (
    item.videoUrl ||
    item.video_url ||
    item.video ||
    item.displayUrl ||
    item.url ||
    null
  );
}

function pickPreviewUrl(item) {
  return (
    item.displayUrl ||
    item.thumbnailUrl ||
    item.thumbnail ||
    item.imageUrl ||
    null
  );
}

function pickCaption(item) {
  return (
    item.caption ||
    item.text ||
    item.description ||
    ''
  );
}

function pickPermalink(item) {
  if (item.permalink) {
    return item.permalink;
  }

  if (item.shortCode) {
    return `https://www.instagram.com/reel/${item.shortCode}/`;
  }

  if (item.url && String(item.url).includes('instagram.com')) {
    return item.url;
  }

  return null;
}

function findReel(db, id) {
  return db.reels.find(r => r.id === id);
}

async function runApify(username) {
  const token = process.env.APIFY_TOKEN;

  if (!token) {
    throw new Error('APIFY_TOKEN is not configured.');
  }

  const actorId =
    'instagram-scraper~instagram-profile-reels-scraper';

  const runUrl =
    `https://api.apify.com/v2/acts/${actorId}/runs?token=${encodeURIComponent(token)}`;

  const response = await fetch(runUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username,
      resultsLimit: 50
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Apify start failed: ${response.status} ${body}`
    );
  }

  const run = await response.json();

  const runId = run.data?.id;
  const datasetId = run.data?.defaultDatasetId;

  if (!runId || !datasetId) {
    throw new Error('Apify did not return a valid run.');
  }

  let status = 'RUNNING';

  for (let i = 0; i < 60; i++) {
    await new Promise(resolve =>
      setTimeout(resolve, 3000)
    );

    const statusResponse = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${encodeURIComponent(token)}`
    );

    if (!statusResponse.ok) {
      const body = await statusResponse.text();
      throw new Error(
        `Apify status failed: ${statusResponse.status} ${body}`
      );
    }

    const statusData = await statusResponse.json();
    status = statusData.data?.status;

    if (
      status === 'SUCCEEDED' ||
      status === 'FAILED' ||
      status === 'ABORTED' ||
      status === 'TIMED-OUT'
    ) {
      break;
    }
  }

  if (status !== 'SUCCEEDED') {
    throw new Error(
      `Apify run finished with status: ${status}`
    );
  }

  const datasetResponse = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(token)}`
  );

  if (!datasetResponse.ok) {
    const body = await datasetResponse.text();
    throw new Error(
      `Apify dataset failed: ${datasetResponse.status} ${body}`
    );
  }

  return await datasetResponse.json();
}

app.get('/api/health', async (req, res) => {
  res.json({
    ok: true,
    version: '1.2',
    service: 'clipper-backend'
  });
});


/* =========================
   ACCOUNTS
========================= */

app.get('/api/accounts', async (req, res) => {
  try {
    const db = await readDb();
    res.json(db.accounts);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.post('/api/accounts', async (req, res) => {
  try {
    const db = await readDb();

    const username = normalizeUsername(
      req.body.username
    );

    if (!username) {
      return res.status(400).json({
        error: 'Username is required.'
      });
    }

    const existing = db.accounts.find(
      account =>
        account.username.toLowerCase() ===
        username.toLowerCase()
    );

    if (existing) {
      return res.json(existing);
    }

    const account = {
      id: crypto.randomUUID(),
      username,
      category: req.body.category || 'meme',
      createdAt: new Date().toISOString()
    };

    db.accounts.push(account);

    await writeDb(db);

    res.json(account);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

app.delete('/api/accounts/:id', async (req, res) => {
  try {
    const db = await readDb();

    db.accounts = db.accounts.filter(
      account => account.id !== req.params.id
    );

    db.reels = db.reels.filter(
      reel => reel.accountId !== req.params.id
    );

    await writeDb(db);

    res.json({
      ok: true
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


/* =========================
   INSTAGRAM SYNC
========================= */

app.post('/api/accounts/:id/sync', async (req, res) => {
  try {
    const db = await readDb();

    const account = db.accounts.find(
      item => item.id === req.params.id
    );

    if (!account) {
      return res.status(404).json({
        error: 'Account not found.'
      });
    }

    const items = await runApify(
      account.username
    );

    let added = 0;
    let updated = 0;

    for (const item of items) {
      const shortCode =
        item.shortCode ||
        item.shortcode ||
        null;

      const permalink =
        pickPermalink(item);

      const videoUrl =
        pickVideoUrl(item);

      const previewUrl =
        pickPreviewUrl(item);

      const caption =
        pickCaption(item);

      let existing = null;

      if (shortCode) {
        existing = db.reels.find(
          reel =>
            reel.shortCode === shortCode
        );
      }

      if (!existing && permalink) {
        existing = db.reels.find(
          reel =>
            reel.permalink === permalink
        );
      }

      if (existing) {
        existing.videoUrl =
          videoUrl || existing.videoUrl;

        existing.previewUrl =
          previewUrl || existing.previewUrl;

        existing.caption =
          caption || existing.caption;

        existing.permalink =
          permalink || existing.permalink;

        existing.updatedAt =
          new Date().toISOString();

        updated++;
        continue;
      }

      db.reels.push({
        id: crypto.randomUUID(),
        accountId: account.id,
        username: account.username,
        shortCode,
        permalink,
        videoUrl,
        previewUrl,
        caption,
        used: false,
        createdAt:
          item.timestamp ||
          item.takenAt ||
          new Date().toISOString(),
        updatedAt:
          new Date().toISOString()
      });

      added++;
    }

    account.lastSync =
      new Date().toISOString();

    account.reelCount =
      db.reels.filter(
        reel =>
          reel.accountId === account.id
      ).length;

    await writeDb(db);

    res.json({
      ok: true,
      added,
      updated,
      total: account.reelCount
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message
    });
  }
});


/* =========================
   REELS
========================= */

app.get('/api/reels', async (req, res) => {
  try {
    const db = await readDb();

    let reels = db.reels;

    if (req.query.accountId) {
      reels = reels.filter(
        reel =>
          reel.accountId ===
          req.query.accountId
      );
    }

    if (req.query.unused === 'true') {
      reels = reels.filter(
        reel => !reel.used
      );
    }

    res.json(reels);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


app.get('/api/reels/:id', async (req, res) => {
  try {
    const db = await readDb();

    const reel =
      findReel(db, req.params.id);

    if (!reel) {
      return res.status(404).json({
        error: 'Reel not found.'
      });
    }

    res.json(reel);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


/* =========================
   RANDOM BATCH
========================= */

app.post('/api/batch/random', async (req, res) => {
  try {
    const db = await readDb();

    const count =
      Math.max(
        1,
        Math.min(
          Number(req.body.count) || 10,
          50
        )
      );

    let available =
      db.reels.filter(
        reel => !reel.used
      );

    available =
      available.sort(
        () => Math.random() - 0.5
      );

    const selected =
      available.slice(0, count);

    const batch = {
      id: crypto.randomUUID(),
      createdAt:
        new Date().toISOString(),
      reelIds:
        selected.map(reel => reel.id)
    };

    db.batches.push(batch);

    await writeDb(db);

    res.json({
      batch,
      reels: selected
    });
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


/* =========================
   DOWNLOAD VIDEO
========================= */

async function downloadFile(url, destination) {
  if (!url) {
    throw new Error(
      'Reel does not have a video URL.'
    );
  }

  const response =
    await fetch(url);

  if (!response.ok) {
    throw new Error(
      `Video download failed: ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  await fs.writeFile(
    destination,
    buffer
  );

  return destination;
}


/* =========================
   EXTRACT FRAMES
========================= */

async function extractFrames(
  videoPath,
  outputDir
) {
  await fs.mkdir(
    outputDir,
    { recursive: true }
  );

  const outputPattern =
    path.join(
      outputDir,
      'frame-%02d.jpg'
    );

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-i',
      videoPath,
      '-vf',
      'fps=1/3,scale=640:-1',
      '-frames:v',
      '6',
      outputPattern
    ],
    {
      maxBuffer:
        10 * 1024 * 1024
    }
  );

  const files =
    await fs.readdir(
      outputDir
    );

  return files
    .filter(
      file =>
        file.endsWith('.jpg')
    )
    .sort()
    .map(
      file =>
        path.join(
          outputDir,
          file
        )
    );
}


/* =========================
   OPENROUTER VISION
========================= */

async function analyzeWithAI(
  framePaths,
  originalCaption
) {
  const apiKey =
    process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured in Render.'
    );
  }

  const content = [
    {
      type: 'text',
      text: `
You are analyzing an Instagram Reel.

IMPORTANT:
Analyze ALL supplied frames together.

Your job is to understand what is ACTUALLY happening in the video.

Do NOT invent dialogue.
Do NOT invent people, events, locations or context.
Do NOT assume something happened if it is not visible.
Do NOT write generic hooks that could apply to any random video.

Create hooks that are specifically relevant to THIS video.

The hooks should feel natural for a viral Instagram Reel.

Keep each hook under 12 words.

Return exactly valid JSON in this format:

{
  "summary": "one short factual description of what happens",
  "hooks": [
    "hook 1",
    "hook 2",
    "hook 3",
    "hook 4",
    "hook 5"
  ],
  "caption": "short caption specifically about this Reel"
}

Existing Instagram caption, if available:
${originalCaption || '(none)'}
`
    }
  ];

  for (
    const framePath of framePaths
  ) {
    const image =
      await fs.readFile(
        framePath
      );

    const base64 =
      image.toString('base64');

    content.push({
      type: 'image_url',
      image_url: {
        url:
          `data:image/jpeg;base64,${base64}`
      }
    });
  }

  const response =
    await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization':
            `Bearer ${apiKey}`,
          'Content-Type':
            'application/json',
          'HTTP-Referer':
            'https://squin1983.github.io/Clipper/',
          'X-Title':
            'Clipper'
        },
        body:
          JSON.stringify({
            model:
              'openrouter/free',
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

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `OpenRouter failed: ${response.status} ${body}`
    );
  }

  const data =
    await response.json();

  const text =
    data.choices?.[0]?.message?.content;

  if (!text) {
    throw new Error(
      'OpenRouter returned no AI response.'
    );
  }

  let cleaned =
    text.trim();

  if (
    cleaned.startsWith('```')
  ) {
    cleaned =
      cleaned
        .replace(/^```json\s*/i, '')
        .replace(/^```\s*/i, '')
        .replace(/\s*```$/i, '')
        .trim();
  }

  let result;

  try {
    result =
      JSON.parse(cleaned);
  } catch {
    throw new Error(
      `AI returned invalid JSON: ${cleaned}`
    );
  }

  if (
    !Array.isArray(result.hooks)
  ) {
    result.hooks = [];
  }

  result.hooks =
    result.hooks
      .filter(Boolean)
      .slice(0, 5);

  return {
    summary:
      result.summary || '',
    hooks:
      result.hooks,
    caption:
      result.caption || ''
  };
}


/* =========================
   AI ANALYZE REEL
========================= */

app.post(
  '/api/reels/:id/analyze',
  async (req, res) => {
    const workId =
      crypto.randomUUID();

    const workDir =
      path.join(
        RAW,
        workId
      );

    try {
      const db =
        await readDb();

      const reel =
        findReel(
          db,
          req.params.id
        );

      if (!reel) {
        return res.status(404).json({
          error:
            'Reel not found.'
        });
      }

      await fs.mkdir(
        workDir,
        {
          recursive: true
        }
      );

      const videoPath =
        path.join(
          workDir,
          'reel.mp4'
        );

      const framesDir =
        path.join(
          workDir,
          'frames'
        );

      console.log(
        `Downloading Reel ${reel.id}`
      );

      await downloadFile(
        reel.videoUrl,
        videoPath
      );

      console.log(
        `Extracting frames for ${reel.id}`
      );

      const frames =
        await extractFrames(
          videoPath,
          framesDir
        );

      if (!frames.length) {
        throw new Error(
          'Could not extract video frames.'
        );
      }

      console.log(
        `Sending ${frames.length} frames to AI`
      );

      const analysis =
        await analyzeWithAI(
          frames,
          reel.caption
        );

      reel.aiAnalysis =
        analysis;

      reel.updatedAt =
        new Date().toISOString();

      await writeDb(db);

      res.json({
        ok: true,
        reelId: reel.id,
        analysis
      });
    } catch (error) {
      console.error(
        'AI analysis error:',
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    } finally {
      try {
        await fs.rm(
          workDir,
          {
            recursive: true,
            force: true
          }
        );
      } catch {}
    }
  }
);


/* =========================
   JOBS
========================= */

app.get(
  '/api/jobs/:id',
  async (req, res) => {
    try {
      const db =
        await readDb();

      const job =
        db.jobs.find(
          item =>
            item.id ===
            req.params.id
        );

      if (!job) {
        return res.status(404).json({
          error:
            'Job not found.'
        });
      }

      res.json(job);
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);


/* =========================
   RENDER
========================= */

app.post(
  '/api/jobs/:id/render',
  async (req, res) => {
    try {
      const db =
        await readDb();

      const reel =
        findReel(
          db,
          req.body.reelId
        );

      if (!reel) {
        return res.status(404).json({
          error:
            'Reel not found.'
        });
      }

      const hook =
        String(
          req.body.hook || ''
        ).trim();

      if (!hook) {
        return res.status(400).json({
          error:
            'Hook is required.'
        });
      }

      const job =
        db.jobs.find(
          item =>
            item.id ===
            req.params.id
        ) ||
        {
          id:
            req.params.id,
          reelId:
            reel.id,
          status:
            'rendering',
          createdAt:
            new Date().toISOString()
        };

      job.status =
        'rendering';

      db.jobs =
        db.jobs.filter(
          item =>
            item.id !==
            job.id
        );

      db.jobs.push(job);

      await writeDb(db);

      const workDir =
        path.join(
          RAW,
          job.id
        );

      await fs.mkdir(
        workDir,
        {
          recursive: true
        }
      );

      const inputPath =
        path.join(
          workDir,
          'input.mp4'
        );

      const outputPath =
        path.join(
          OUTPUT,
          `${job.id}.mp4`
        );

      await downloadFile(
        reel.videoUrl,
        inputPath
      );

      const font =
        '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

      const escapedHook =
        hook
          .replace(/\\/g, '\\\\')
          .replace(/'/g, "\\'")
          .replace(/:/g, '\\:')
          .replace(/%/g, '\\%');

      const drawText =
        `drawtext=fontfile=${font}:` +
        `text='${escapedHook}':` +
        `fontcolor=white:` +
        `fontsize=42:` +
        `borderw=4:` +
        `bordercolor=black:` +
        `x=(w-text_w)/2:` +
        `y=70:` +
        `box=1:` +
        `boxcolor=black@0.35:` +
        `boxborderw=18`;

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          inputPath,
          '-vf',
          drawText,
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '23',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          outputPath
        ],
        {
          maxBuffer:
            20 * 1024 * 1024
        }
      );

      job.status =
        'ready';

      job.outputUrl =
        `/media/${path.basename(
          outputPath
        )}`;

      job.updatedAt =
        new Date().toISOString();

      reel.used =
        true;

      await writeDb(db);

      res.json({
        ok: true,
        job
      });
    } catch (error) {
      console.error(
        'Render error:',
        error
      );

      try {
        const db =
          await readDb();

        const job =
          db.jobs.find(
            item =>
              item.id ===
              req.params.id
          );

        if (job) {
          job.status =
            'failed';

          job.error =
            error.message;

          await writeDb(db);
        }
      } catch {}

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);


/* =========================
   BATCHES
========================= */

app.get(
  '/api/batches',
  async (req, res) => {
    try {
      const db =
        await readDb();

      res.json(
        db.batches
          .slice()
          .reverse()
      );
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.get(
  '/api/batches/:id',
  async (req, res) => {
    try {
      const db =
        await readDb();

      const batch =
        db.batches.find(
          item =>
            item.id ===
            req.params.id
        );

      if (!batch) {
        return res.status(404).json({
          error:
            'Batch not found.'
        });
      }

      const reels =
        batch.reelIds
          .map(id =>
            findReel(db, id)
          )
          .filter(Boolean);

      res.json({
        batch,
        reels
      });
    } catch (error) {
      res.status(500).json({
        error:
          error.message
      });
    }
  }
);


/* =========================
   MEDIA
========================= */

app.use(
  '/media',
  express.static(OUTPUT)
);


/* =========================
   START
========================= */

ensureStorage()
  .then(() => {
    app.listen(
      PORT,
      () => {
        console.log(
          `Clipper backend running on port ${PORT}`
        );
      }
    );
  })
  .catch(error => {
    console.error(
      'Startup failed:',
      error
    );

    process.exit(1);
  });
