const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

dotenv.config();

const execFileAsync = promisify(execFile);

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 10000;

const DB_FILE = '/tmp/clipper-db.json';

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';

const APIFY_ACTOR =
  'instagram-scraper~instagram-profile-reels-scraper';

const OPENROUTER_MODEL = 'openrouter/free';

const RENDER_DIR = '/tmp/clipper-renders';

if (!fs.existsSync(RENDER_DIR)) {
  fs.mkdirSync(RENDER_DIR, { recursive: true });
}


/* =========================================================
   DATABASE
========================================================= */

function defaultDb() {
  return {
    accounts: [],
    reels: [],
    batches: [],
    jobs: []
  };
}


function loadDb() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      return defaultDb();
    }

    const raw = fs.readFileSync(DB_FILE, 'utf8');

    if (!raw.trim()) {
      return defaultDb();
    }

    const db = JSON.parse(raw);

    return {
      accounts: Array.isArray(db.accounts) ? db.accounts : [],
      reels: Array.isArray(db.reels) ? db.reels : [],
      batches: Array.isArray(db.batches) ? db.batches : [],
      jobs: Array.isArray(db.jobs) ? db.jobs : []
    };

  } catch (error) {
    console.error('Database load failed:', error);
    return defaultDb();
  }
}


function saveDb(db) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(db, null, 2),
    'utf8'
  );
}


/* =========================================================
   HELPERS
========================================================= */

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .replace(/\/.*$/, '')
    .trim();
}


function getReelDate(reel) {
  const possibleDates = [
    reel.publishedAt,
    reel.takenAt,
    reel.timestamp,
    reel.createdAt,
    reel.date
  ];

  for (const value of possibleDates) {
    if (!value) {
      continue;
    }

    const time = new Date(value).getTime();

    if (!Number.isNaN(time)) {
      return time;
    }
  }

  return null;
}


function normalizeReelDate(item) {
  const possibleDates = [
    item.publishedAt,
    item.takenAt,
    item.timestamp,
    item.date,
    item.createdAt
  ];

  for (const value of possibleDates) {
    if (!value) {
      continue;
    }

    const parsed = new Date(value);

    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return null;
}


function getInstagramUrl(item) {
  return (
    item.url ||
    item.permalink ||
    item.webUrl ||
    item.shortcodeUrl ||
    item.instagramUrl ||
    null
  );
}


function getVideoUrl(item) {
  return (
    item.videoUrl ||
    item.video_url ||
    item.downloadUrl ||
    item.mediaUrl ||
    item.url ||
    null
  );
}


function getThumbnailUrl(item) {
  return (
    item.displayUrl ||
    item.thumbnailUrl ||
    item.thumbnail ||
    item.imageUrl ||
    item.coverUrl ||
    null
  );
}


function getShortcode(item) {
  return (
    item.shortCode ||
    item.shortcode ||
    item.code ||
    null
  );
}


function makeReelId(item) {
  const source =
    getInstagramUrl(item) ||
    getShortcode(item) ||
    crypto.randomUUID();

  return crypto
    .createHash('sha1')
    .update(String(source))
    .digest('hex')
    .slice(0, 16);
}


function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}


/* =========================================================
   GENERIC HTTP
========================================================= */

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const isHttps = parsed.protocol === 'https:';

    const transport = isHttps ? https : http;

    const requestOptions = {
      method: options.method || 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      headers: options.headers || {}
    };

    const request = transport.request(
      requestOptions,
      response => {
        let body = '';

        response.on('data', chunk => {
          body += chunk;
        });

        response.on('end', () => {
          const status = response.statusCode || 0;

          let parsedBody = body;

          try {
            parsedBody = JSON.parse(body);
          } catch (_) {
            // Non-JSON response.
          }

          if (status >= 200 && status < 300) {
            resolve({
              status,
              body: parsedBody
            });
            return;
          }

          reject(
            new Error(
              `HTTP ${status}: ${
                typeof parsedBody === 'string'
                  ? parsedBody
                  : JSON.stringify(parsedBody)
              }`
            )
          );
        });
      }
    );

    request.on('error', reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}


/* =========================================================
   DOWNLOAD
========================================================= */

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);

    const transport =
      parsed.protocol === 'https:'
        ? https
        : http;

    const file = fs.createWriteStream(outputPath);

    const request = transport.get(
      url,
      response => {

        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          file.close();

          try {
            fs.unlinkSync(outputPath);
          } catch (_) {}

          downloadFile(
            response.headers.location,
            outputPath
          )
            .then(resolve)
            .catch(reject);

          return;
        }

        if (response.statusCode !== 200) {
          file.close();

          try {
            fs.unlinkSync(outputPath);
          } catch (_) {}

          reject(
            new Error(
              `Download failed with HTTP ${response.statusCode}`
            )
          );

          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close(resolve);
        });
      }
    );

    request.on('error', error => {
      file.close();

      try {
        fs.unlinkSync(outputPath);
      } catch (_) {}

      reject(error);
    });
  });
}


/* =========================================================
   APIFY
========================================================= */

async function runApifyProfile(username) {
  if (!APIFY_TOKEN) {
    throw new Error(
      'APIFY_TOKEN is not configured on Render.'
    );
  }

  const clean = cleanUsername(username);

  if (!clean) {
    throw new Error('Instagram username is required.');
  }

  const input = {
    instagramUsernames: [clean],
    resultsLimit: 150
  };

  const actorUrl =
    `https://api.apify.com/v2/acts/${encodeURIComponent(
      APIFY_ACTOR
    )}/runs?token=${encodeURIComponent(
      APIFY_TOKEN
    )}`;

  console.log(
    'Starting Apify actor for:',
    clean
  );

  const start = await requestJson(
    actorUrl,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(input)
    }
  );

  const runId =
    start.body &&
    start.body.data &&
    start.body.data.id;

  if (!runId) {
    throw new Error(
      `Apify start failed: ${JSON.stringify(start.body)}`
    );
  }

  console.log(
    'Apify run started:',
    runId
  );

  const maxAttempts = 60;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {

    await sleep(3000);

    const statusUrl =
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(
        runId
      )}?token=${encodeURIComponent(
        APIFY_TOKEN
      )}`;

    const statusResponse =
      await requestJson(statusUrl);

    const status =
      statusResponse.body &&
      statusResponse.body.data &&
      statusResponse.body.data.status;

    console.log(
      `Apify status ${attempt + 1}/${maxAttempts}:`,
      status
    );

    if (status === 'SUCCEEDED') {

      const datasetId =
        statusResponse.body.data.defaultDatasetId;

      const datasetUrl =
        `https://api.apify.com/v2/datasets/${encodeURIComponent(
          datasetId
        )}/items?clean=true&token=${encodeURIComponent(
          APIFY_TOKEN
        )}`;

      const dataset =
        await requestJson(datasetUrl);

      return Array.isArray(dataset.body)
        ? dataset.body
        : [];
    }

    if (
      status === 'FAILED' ||
      status === 'ABORTED' ||
      status === 'TIMED-OUT'
    ) {
      throw new Error(
        `Apify run ended with status: ${status}`
      );
    }
  }

  throw new Error(
    'Apify run timed out.'
  );
}


/* =========================================================
   HEALTH
========================================================= */

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: '1.3',
    service: 'clipper-backend',
    aiConfigured: Boolean(
      OPENROUTER_API_KEY
    ),
    apifyConfigured: Boolean(
      APIFY_TOKEN
    )
  });
});


/* =========================================================
   ACCOUNTS
========================================================= */

app.get('/api/accounts', (req, res) => {
  const db = loadDb();

  res.json({
    accounts: db.accounts
  });
});


app.post('/api/accounts', (req, res) => {
  try {
    const db = loadDb();

    const username =
      cleanUsername(req.body.username);

    const name =
      String(
        req.body.name ||
        username
      ).trim();

    const category =
      String(
        req.body.category ||
        'meme'
      ).trim();

    if (!username) {
      return res.status(400).json({
        error: 'Instagram username is required.'
      });
    }

    const existing =
      db.accounts.find(
        account =>
          account.username.toLowerCase() ===
          username.toLowerCase()
      );

    if (existing) {
      return res.json({
        account: existing
      });
    }

    const account = {
      id: crypto.randomUUID(),
      username,
      name,
      category,
      createdAt: new Date().toISOString()
    };

    db.accounts.push(account);

    saveDb(db);

    res.json({
      account
    });

  } catch (error) {
    console.error(
      'Create account failed:',
      error
    );

    res.status(500).json({
      error: error.message
    });
  }
});


app.delete('/api/accounts/:id', (req, res) => {
  try {
    const db = loadDb();

    const id = String(req.params.id);

    db.accounts =
      db.accounts.filter(
        account =>
          String(account.id) !== id
      );

    saveDb(db);

    res.json({
      ok: true
    });

  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});


/* =========================================================
   SYNC ACCOUNT
========================================================= */

app.post(
  '/api/accounts/:id/sync',
  async (req, res) => {

    try {

      const db = loadDb();

      const account =
        db.accounts.find(
          item =>
            String(item.id) ===
            String(req.params.id)
        );

      if (!account) {
        return res.status(404).json({
          error: 'Account not found.'
        });
      }

      const items =
        await runApifyProfile(
          account.username
        );

      let added = 0;
      let skipped = 0;

      for (const item of items) {

        const instagramUrl =
          getInstagramUrl(item);

        const shortcode =
          getShortcode(item);

        const duplicate =
          db.reels.find(reel => {

            if (
              instagramUrl &&
              reel.instagramUrl
            ) {
              return (
                reel.instagramUrl ===
                instagramUrl
              );
            }

            if (
              shortcode &&
              reel.shortcode
            ) {
              return (
                reel.shortcode ===
                shortcode
              );
            }

            return false;
          });

        if (duplicate) {
          skipped++;
          continue;
        }

        const reel = {
          id: makeReelId(item),

          accountId: account.id,

          accountUsername:
            account.username,

          shortcode,

          instagramUrl,

          videoUrl:
            getVideoUrl(item),

          thumbnailUrl:
            getThumbnailUrl(item),

          publishedAt:
            normalizeReelDate(item),

          title:
            item.caption ||
            item.title ||
            '',

          caption:
            item.caption ||
            '',

          duration:
            item.duration ||
            null,

          used: false,

          analyzed: false,

          analysis: null,

          selectedHook: null,

          aiCaption: null,

          rendered: false,

          renderedAt: null,

          createdAt:
            new Date().toISOString(),

          source: item
        };

        db.reels.push(reel);

        added++;
      }

      saveDb(db);

      res.json({
        ok: true,

        account,

        totalFromInstagram:
          items.length,

        added,

        skipped,

        totalStored:
          db.reels.filter(
            reel =>
              String(reel.accountId) ===
              String(account.id)
          ).length
      });

    } catch (error) {

      console.error(
        'Sync failed:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Instagram sync failed.'
      });
    }
  }
);


/* =========================================================
   REELS
========================================================= */

app.get('/api/reels', (req, res) => {

  const db = loadDb();

  let reels = [...db.reels];

  if (req.query.accountId) {
    reels =
      reels.filter(
        reel =>
          String(reel.accountId) ===
          String(req.query.accountId)
      );
  }

  if (req.query.unused === 'true') {
    reels =
      reels.filter(
        reel => !reel.used
      );
  }

  reels.sort((a, b) => {

    const dateA =
      getReelDate(a);

    const dateB =
      getReelDate(b);

    if (dateA === null && dateB === null) {
      return 0;
    }

    if (dateA === null) {
      return 1;
    }

    if (dateB === null) {
      return -1;
    }

    return dateA - dateB;
  });

  const limit =
    Math.min(
      Math.max(
        Number(req.query.limit) || 100,
        1
      ),
      500
    );

  reels =
    reels.slice(0, limit);

  res.json({
    reels
  });
});


/* =========================================================
   RANDOM / OLD UNUSED BATCH
========================================================= */

app.get(
  '/api/batch/random',
  (req, res) => {

    try {

      const db = loadDb();

      const accountId =
        req.query.accountId
          ? String(req.query.accountId)
          : null;

      const limit =
        Math.min(
          Math.max(
            Number(req.query.limit) || 10,
            1
          ),
          50
        );

      let candidates =
        db.reels.filter(reel => {

          if (reel.used) {
            return false;
          }

          if (
            accountId &&
            String(reel.accountId) !==
              accountId
          ) {
            return false;
          }

          return true;
        });


      /*
       * NAJSTARŠIE NEPOUŽITÉ REELS PRVÉ
       */

      candidates.sort((a, b) => {

        const dateA =
          getReelDate(a);

        const dateB =
          getReelDate(b);

        if (
          dateA === null &&
          dateB === null
        ) {
          return String(a.id)
            .localeCompare(
              String(b.id)
            );
        }

        if (dateA === null) {
          return 1;
        }

        if (dateB === null) {
          return -1;
        }

        return dateA - dateB;
      });


      const selected =
        candidates.slice(
          0,
          limit
        );


      const batch = {

        id: crypto.randomUUID(),

        accountId:
          accountId || null,

        reelIds:
          selected.map(
            reel => reel.id
          ),

        createdAt:
          new Date().toISOString()
      };


      db.batches.unshift(batch);

      saveDb(db);


      res.json({

        batch,

        reels: selected,

        count:
          selected.length

      });

    } catch (error) {

      console.error(
        'Random batch failed:',
        error
      );

      res.status(500).json({

        error:
          error.message ||
          'Failed to create batch.'

      });
    }
  }
);


/* =========================================================
   AI ANALYSIS
========================================================= */

async function extractFrames(
  videoPath,
  outputDir
) {

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(
      outputDir,
      {
        recursive: true
      }
    );
  }

  const pattern =
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
      'fps=1/3,scale=768:-2',
      '-frames:v',
      '6',
      pattern
    ]
  );

  const files =
    fs.readdirSync(
      outputDir
    )
      .filter(
        file =>
          /^frame-\d+\.jpg$/i.test(file)
      )
      .sort();

  return files.map(
    file =>
      path.join(
        outputDir,
        file
      )
  );
}


function fileToDataUrl(filePath) {

  const buffer =
    fs.readFileSync(
      filePath
    );

  return (
    'data:image/jpeg;base64,' +
    buffer.toString('base64')
  );
}


async function analyzeWithOpenRouter(
  frameFiles,
  reel
) {

  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured on Render.'
    );
  }

  const imageMessages =
    frameFiles.map(file => ({
      type: 'image_url',
      image_url: {
        url:
          fileToDataUrl(file)
      }
    }));


  const prompt = `
You are Clipper, a private Instagram Reel editing assistant.

Analyze ONLY what is visibly present in the provided video frames.

Do NOT invent:
- dialogue
- people
- events
- locations
- relationships
- plot details
- facts that cannot be seen

Create:

1. A short factual summary of what is visible.

2. Exactly 5 short on-screen hook options.

Each hook:
- maximum 12 words
- modern social-media style
- specific to this actual video
- curiosity-driven
- natural
- not generic
- do not copy wording from the source

3. One concise Instagram/TikTok caption.

Return ONLY valid JSON:

{
  "summary": "...",
  "hooks": [
    "...",
    "...",
    "...",
    "...",
    "..."
  ],
  "caption": "..."
}

The Reel currently has this source caption if available:

${String(reel.caption || '').slice(0, 1000)}
`;


  const body = {

    model:
      OPENROUTER_MODEL,

    messages: [

      {
        role: 'system',

        content:
          'You are a precise social media content assistant. Never invent visual facts.'
      },

      {
        role: 'user',

        content: [

          {
            type: 'text',

            text: prompt
          },

          ...imageMessages

        ]
      }

    ],

    temperature: 0.8,

    max_tokens: 900

  };


  const response =
    await requestJson(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',

        headers: {

          'Content-Type':
            'application/json',

          'Authorization':
            `Bearer ${OPENROUTER_API_KEY}`,

          'HTTP-Referer':
            'https://squin1983.github.io/Clipper/',

          'X-Title':
            'Clipper'
        },

        body:
          JSON.stringify(body)
      }
    );


  const content =
    response.body &&
    response.body.choices &&
    response.body.choices[0] &&
    response.body.choices[0].message &&
    response.body.choices[0].message.content;


  if (!content) {
    throw new Error(
      'OpenRouter returned no AI content.'
    );
  }


  let cleaned =
    String(content)
      .trim()
      .replace(/^```json/i, '')
      .replace(/^```/i, '')
      .replace(/```$/i, '')
      .trim();


  let parsed;

  try {

    parsed =
      JSON.parse(cleaned);

  } catch (error) {

    const firstBrace =
      cleaned.indexOf('{');

    const lastBrace =
      cleaned.lastIndexOf('}');

    if (
      firstBrace >= 0 &&
      lastBrace > firstBrace
    ) {

      parsed =
        JSON.parse(
          cleaned.slice(
            firstBrace,
            lastBrace + 1
          )
        );

    } else {

      throw new Error(
        'AI returned invalid JSON.'
      );
    }
  }


  const hooks =
    Array.isArray(parsed.hooks)
      ? parsed.hooks
          .map(
            hook =>
              String(hook)
                .trim()
          )
          .filter(Boolean)
          .slice(0, 5)
      : [];


  while (hooks.length < 5) {
    hooks.push('');
  }


  return {

    summary:
      String(
        parsed.summary || ''
      ).trim(),

    hooks,

    caption:
      String(
        parsed.caption || ''
      ).trim()

  };
}


app.post(
  '/api/reels/:id/analyze',
  async (req, res) => {

    let workDir = null;

    try {

      const db = loadDb();

      const reel =
        db.reels.find(
          item =>
            String(item.id) ===
            String(req.params.id)
        );

      if (!reel) {
        return res.status(404).json({
          error: 'Reel not found.'
        });
      }

      if (!reel.videoUrl) {
        return res.status(400).json({
          error:
            'This Reel does not have a downloadable video URL.'
        });
      }


      workDir =
        path.join(
          '/tmp',
          `clipper-ai-${crypto.randomUUID()}`
        );

      fs.mkdirSync(
        workDir,
        {
          recursive: true
        }
      );


      const videoPath =
        path.join(
          workDir,
          'source.mp4'
        );


      console.log(
        'Downloading video for AI:',
        reel.videoUrl
      );


      await downloadFile(
        reel.videoUrl,
        videoPath
      );


      const frameDir =
        path.join(
          workDir,
          'frames'
        );


      const frameFiles =
        await extractFrames(
          videoPath,
          frameDir
        );


      if (!frameFiles.length) {
        throw new Error(
          'Could not extract video frames.'
        );
      }


      const analysis =
        await analyzeWithOpenRouter(
          frameFiles,
          reel
        );


      reel.analysis =
        analysis;

      reel.analyzed = true;

      reel.selectedHook =
        analysis.hooks[0] || '';

      reel.aiCaption =
        analysis.caption || '';


      saveDb(db);


      res.json({

        ok: true,

        reel,

        analysis

      });


    } catch (error) {

      console.error(
        'AI analysis failed:',
        error
      );

      res.status(500).json({

        error:
          error.message ||
          'AI analysis failed.'

      });

    } finally {

      if (workDir) {

        try {

          fs.rmSync(
            workDir,
            {
              recursive: true,
              force: true
            }
          );

        } catch (_) {}

      }
    }
  }
);


/* =========================================================
   RENDER
========================================================= */

app.post(
  '/api/jobs/:id/render',
  async (req, res) => {

    try {

      const db = loadDb();

      const reel =
        db.reels.find(
          item =>
            String(item.id) ===
            String(req.params.id)
        );


      if (!reel) {

        return res.status(404).json({
          error: 'Reel not found.'
        });

      }


      if (!reel.videoUrl) {

        return res.status(400).json({
          error:
            'This Reel does not have a video URL.'
        });

      }


      const hook =
        String(
          req.body.hook ||
          reel.selectedHook ||
          ''
        ).trim();


      if (!hook) {

        return res.status(400).json({
          error:
            'A hook is required before rendering.'
        });

      }


      const jobId =
        crypto.randomUUID();


      const job = {

        id: jobId,

        reelId: reel.id,

        status: 'processing',

        hook,

        createdAt:
          new Date().toISOString(),

        outputPath: null,

        error: null

      };


      db.jobs.unshift(job);

      saveDb(db);


      const workDir =
        path.join(
          '/tmp',
          `clipper-render-${jobId}`
        );


      fs.mkdirSync(
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
          RENDER_DIR,
          `${jobId}.mp4`
        );


      console.log(
        'Downloading Reel for render...'
      );


      await downloadFile(
        reel.videoUrl,
        inputPath
      );


      /*
       * Final format:
       *
       * 1080 x 1920
       * vertical 9:16
       *
       * Horizontal source is NOT cropped.
       *
       * The video is fitted inside the
       * vertical canvas.
       */


      const category =
        String(
          req.body.category ||
          ''
        ).toLowerCase();


      const isMovie =
        category === 'movie_tv' ||
        category === 'movie' ||
        category === 'tv';


      const isMusic =
        category === 'music';


      const isMeme =
        category === 'meme';


      let background = 'white';

      let textColor = 'black';


      if (isMusic || isMeme) {

        background = 'black';

        textColor = 'white';

      }


      if (isMovie) {

        background = 'white';

        textColor = 'black';

      }


      const safeText =
        hook
          .replace(/\\/g, '\\\\')
          .replace(/:/g, '\\:')
          .replace(/'/g, "\\'")
          .replace(/"/g, '\\"')
          .replace(/\[/g, '\\[')
          .replace(/\]/g, '\\]');


      const drawText =
        `drawtext=fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:text='${safeText}':fontcolor=${textColor}:fontsize=58:x=(w-text_w)/2:y=120:box=0`;


      await execFileAsync(
        'ffmpeg',
        [

          '-y',

          '-i',
          inputPath,

          '-filter_complex',

          `[0:v]scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=${background},${drawText}[v]`,

          '-map',
          '[v]',

          '-map',
          '0:a?',

          '-c:v',
          'libx264',

          '-preset',
          'veryfast',

          '-crf',
          '23',

          '-c:a',
          'aac',

          '-b:a',
          '128k',

          '-movflags',
          '+faststart',

          outputPath

        ]
      );


      job.status =
        'completed';

      job.outputPath =
        outputPath;

      job.previewUrl =
        `/api/jobs/${jobId}/file`;


      reel.used = true;

      reel.rendered = true;

      reel.renderedAt =
        new Date().toISOString();

      reel.selectedHook =
        hook;


      saveDb(db);


      try {

        fs.rmSync(
          workDir,
          {
            recursive: true,
            force: true
          }
        );

      } catch (_) {}


      res.json({

        ok: true,

        job,

        previewUrl:
          `/api/jobs/${jobId}/file`

      });


    } catch (error) {

      console.error(
        'Render failed:',
        error
      );


      const db = loadDb();

      const job =
        db.jobs.find(
          item =>
            String(item.id) ===
            String(req.params.id)
        );


      if (job) {

        job.status =
          'failed';

        job.error =
          error.message;

        saveDb(db);

      }


      res.status(500).json({

        error:
          error.message ||
          'Render failed.'

      });

    }
  }
);


/* =========================================================
   RENDER FILE
========================================================= */

app.get(
  '/api/jobs/:id/file',
  (req, res) => {

    const db = loadDb();

    const job =
      db.jobs.find(
        item =>
          String(item.id) ===
          String(req.params.id)
      );


    if (!job) {

      return res.status(404).json({
        error: 'Job not found.'
      });

    }


    if (
      !job.outputPath ||
      !fs.existsSync(
        job.outputPath
      )
    ) {

      return res.status(404).json({

        error:
          'Rendered video is no longer available.'

      });

    }


    res.setHeader(
      'Content-Type',
      'video/mp4'
    );


    res.setHeader(
      'Content-Disposition',
      `inline; filename="clipper-${job.id}.mp4"`
    );


    fs.createReadStream(
      job.outputPath
    ).pipe(res);

  }
);


/* =========================================================
   JOB
========================================================= */

app.get(
  '/api/jobs/:id',
  (req, res) => {

    const db = loadDb();

    const job =
      db.jobs.find(
        item =>
          String(item.id) ===
          String(req.params.id)
      );


    if (!job) {

      return res.status(404).json({
        error: 'Job not found.'
      });

    }


    res.json({
      job
    });

  }
);


/* =========================================================
   BATCHES
========================================================= */

app.get(
  '/api/batches',
  (req, res) => {

    const db = loadDb();

    res.json({
      batches: db.batches
    });

  }
);


app.get(
  '/api/batches/:id',
  (req, res) => {

    const db = loadDb();

    const batch =
      db.batches.find(
        item =>
          String(item.id) ===
          String(req.params.id)
      );


    if (!batch) {

      return res.status(404).json({
        error: 'Batch not found.'
      });

    }


    const reels =
      batch.reelIds
        .map(
          id =>
            db.reels.find(
              reel =>
                String(reel.id) ===
                String(id)
            )
        )
        .filter(Boolean);


    res.json({

      batch,

      reels

    });

  }
);


/* =========================================================
   START SERVER
========================================================= */

app.listen(
  PORT,
  () => {

    console.log(
      `Clipper backend listening on port ${PORT}`
    );

    console.log(
      'APIFY_TOKEN:',
      APIFY_TOKEN
        ? 'configured'
        : 'missing'
    );

    console.log(
      'OPENROUTER_API_KEY:',
      OPENROUTER_API_KEY
        ? 'configured'
        : 'missing'
    );

  }
);
