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
const VERSION = '1.5';

const APIFY_TOKEN = process.env.APIFY_TOKEN;
const APIFY_ACTOR =
  process.env.APIFY_ACTOR ||
  'instagram-scraper~instagram-profile-reels-scraper';

const APIFY_POSTS_PER_PROFILE = Number(
  process.env.APIFY_POSTS_PER_PROFILE || 500
);

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL || 'openrouter/free';

const DB_FILE = '/tmp/clipper-db.json';
const RENDER_DIR = '/tmp/clipper-renders';

if (!fs.existsSync(RENDER_DIR)) {
  fs.mkdirSync(RENDER_DIR, { recursive: true });
}

function createEmptyDb() {
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
      return createEmptyDb();
    }

    const data = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

    return {
      accounts: Array.isArray(data.accounts) ? data.accounts : [],
      reels: Array.isArray(data.reels) ? data.reels : [],
      batches: Array.isArray(data.batches) ? data.batches : [],
      jobs: Array.isArray(data.jobs) ? data.jobs : []
    };
  } catch (error) {
    console.error('DB load error:', error.message);
    return createEmptyDb();
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function id() {
  return crypto.randomUUID();
}

function cleanUsername(value) {
  return String(value || '')
    .trim()
    .replace(/^@/, '')
    .replace(/\s+/g, '');
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ''
    ) {
      return value;
    }
  }

  return null;
}

function getNested(obj, paths) {
  for (const parts of paths) {
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) {
        break;
      }

      current = current[part];
    }

    if (
      current !== undefined &&
      current !== null &&
      String(current).trim() !== ''
    ) {
      return current;
    }
  }

  return null;
}

function getInstagramUrl(item) {
  return firstNonEmpty(
    item.url,
    item.permalink,
    item.webUrl,
    item.postUrl,
    item.reelUrl,
    item.reel_url,
    item.shortcodeUrl,
    item.instagramUrl,
    item.inputUrl
  );
}

function getVideoUrl(item) {
  return firstNonEmpty(
    item.videoUrl,
    item.video_url,
    item.downloadUrl,
    item.download_url,
    item.mediaUrl,
    item.video,
    item.video?.url,
    item.video?.videoUrl,
    getNested(item, [
      ['media', 'videoUrl'],
      ['media', 'video_url'],
      ['media', 'video', 'url'],
      ['media', 'video', 'videoUrl']
    ]),
    getNested(item, [
      ['video_versions', '0', 'url'],
      ['videoVersions', '0', 'url']
    ])
  );
}

function getThumbnailUrl(item) {
  return firstNonEmpty(
    item.displayUrl,
    item.display_url,
    item.thumbnailUrl,
    item.thumbnail_url,
    item.thumbnailSrc,
    item.thumbnail,
    item.imageUrl,
    item.coverUrl,
    item.image,
    getNested(item, [
      ['media', 'thumbnailUrl'],
      ['media', 'thumbnail_url'],
      ['media', 'thumbnail']
    ])
  );
}

function getShortcode(item) {
  return firstNonEmpty(
    item.shortCode,
    item.short_code,
    item.shortcode,
    item.code
  );
}

function parseDateValue(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    const timestamp = value < 100000000000 ? value * 1000 : value;
    const date = new Date(timestamp);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const stringValue = String(value).trim();

  if (/^\d+$/.test(stringValue)) {
    const number = Number(stringValue);
    const timestamp =
      number < 100000000000 ? number * 1000 : number;

    const date = new Date(timestamp);

    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  const date = new Date(stringValue);

  return Number.isNaN(date.getTime())
    ? null
    : date.toISOString();
}

function normalizeReelDate(item) {
  return parseDateValue(
    firstNonEmpty(
      item.publishedAt,
      item.takenAt,
      item.timestamp,
      item.date,
      item.createdAt,
      item.taken_at,
      item.takenAtTimestamp,
      item.taken_at_timestamp,
      item.pubDate,
      item.pub_date
    )
  );
}

function getCaption(item) {
  return firstNonEmpty(
    item.caption,
    item.title,
    item.description,
    item.text,
    item.captionText,
    getNested(item, [
      ['caption', 'text'],
      ['edge_media_to_caption', 'edges', '0', 'node', 'text']
    ])
  ) || '';
}

function getDuration(item) {
  const value = firstNonEmpty(
    item.duration,
    item.videoDuration,
    item.video_duration,
    getNested(item, [
      ['video', 'duration'],
      ['media', 'duration']
    ])
  );

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}

function getSourceId(item) {
  return firstNonEmpty(
    item.id,
    item.pk,
    item.mediaId,
    item.media_id
  );
}

function isDuplicateReel(db, instagramUrl, shortcode) {
  return db.reels.some((reel) => {
    if (
      instagramUrl &&
      reel.instagramUrl &&
      instagramUrl === reel.instagramUrl
    ) {
      return true;
    }

    if (
      shortcode &&
      reel.shortcode &&
      shortcode === reel.shortcode
    ) {
      return true;
    }

    return false;
  });
}

function safeFileName(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 100);
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const transport = parsed.protocol === 'https:' ? https : http;

    const request = transport.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        timeout: options.timeout || 90000
      },
      (response) => {
        let body = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          body += chunk;
        });

        response.on('end', () => {
          let parsedBody = body;

          try {
            parsedBody = JSON.parse(body);
          } catch (_) {}

          if (
            response.statusCode < 200 ||
            response.statusCode >= 300
          ) {
            const error = new Error(
              `HTTP ${response.statusCode}`
            );

            error.statusCode = response.statusCode;
            error.body = parsedBody;

            reject(error);
            return;
          }

          resolve(parsedBody);
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('Request timed out'));
    });

    request.on('error', reject);

    if (options.body) {
      request.write(options.body);
    }

    request.end();
  });
}

function downloadFile(url, destination, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('Missing download URL'));
      return;
    }

    if (redirects > 8) {
      reject(new Error('Too many redirects'));
      return;
    }

    let parsed;

    try {
      parsed = new URL(url);
    } catch (_) {
      reject(new Error('Invalid download URL'));
      return;
    }

    const transport =
      parsed.protocol === 'https:' ? https : http;

    const file = fs.createWriteStream(destination);

    const request = transport.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
          Accept: '*/*',
          Referer: 'https://www.instagram.com/'
        },
        timeout: 60000
      },
      (response) => {
        if (
          [301, 302, 303, 307, 308].includes(
            response.statusCode
          ) &&
          response.headers.location
        ) {
          file.destroy();

          downloadFile(
            response.headers.location,
            destination,
            redirects + 1
          )
            .then(resolve)
            .catch(reject);

          return;
        }

        if (
          response.statusCode < 200 ||
          response.statusCode >= 300
        ) {
          file.destroy();
          reject(
            new Error(
              `Download failed with HTTP ${response.statusCode}`
            )
          );
          return;
        }

        response.pipe(file);

        file.on('finish', () => {
          file.close(() => {
            try {
              const stats = fs.statSync(destination);

              if (!stats.size) {
                reject(new Error('Downloaded file is empty'));
                return;
              }

              resolve(destination);
            } catch (error) {
              reject(error);
            }
          });
        });
      }
    );

    request.on('timeout', () => {
      request.destroy(new Error('Download timed out'));
    });

    request.on('error', (error) => {
      file.destroy();
      reject(error);
    });
  });
}

async function runApifyProfile(username) {
  if (!APIFY_TOKEN) {
    throw new Error('APIFY_TOKEN is not configured on Render.');
  }

  const input = {
    instagramUsernames: [username],
    postsPerProfile: APIFY_POSTS_PER_PROFILE
  };

  console.log(
    `Starting Apify for @${username}, postsPerProfile=${APIFY_POSTS_PER_PROFILE}`
  );

  const startUrl =
    `https://api.apify.com/v2/acts/${encodeURIComponent(APIFY_ACTOR)}/runs` +
    `?token=${encodeURIComponent(APIFY_TOKEN)}`;

  const startResponse = await requestJson(startUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(input),
    timeout: 60000
  });

  const runId =
    startResponse?.data?.id ||
    startResponse?.id;

  if (!runId) {
    throw new Error(
      'Apify did not return a run ID.'
    );
  }

  console.log(`Apify run started: ${runId}`);

  let runData = null;

  for (let attempt = 1; attempt <= 80; attempt++) {
    await new Promise((resolve) =>
      setTimeout(resolve, 3000)
    );

    const statusUrl =
      `https://api.apify.com/v2/actor-runs/${runId}` +
      `?token=${encodeURIComponent(APIFY_TOKEN)}`;

    const statusResponse = await requestJson(
      statusUrl,
      {
        timeout: 30000
      }
    );

    runData = statusResponse?.data || statusResponse;

    const status = runData?.status;

    console.log(
      `Apify status ${attempt}/80: ${status}`
    );

    if (
      ['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT'].includes(
        status
      )
    ) {
      break;
    }
  }

  if (!runData) {
    throw new Error('No Apify run status received.');
  }

  if (runData.status !== 'SUCCEEDED') {
    throw new Error(
      `Apify run ended with status: ${runData.status}`
    );
  }

  const datasetId = runData.defaultDatasetId;

  if (!datasetId) {
    throw new Error(
      'Apify run completed but no dataset was returned.'
    );
  }

  const datasetUrl =
    `https://api.apify.com/v2/datasets/${datasetId}/items` +
    `?token=${encodeURIComponent(APIFY_TOKEN)}` +
    `&clean=true`;

  const items = await requestJson(datasetUrl, {
    timeout: 60000
  });

  if (!Array.isArray(items)) {
    throw new Error(
      'Apify returned an invalid dataset.'
    );
  }

  console.log(
    `Apify returned ${items.length} items for @${username}`
  );

  if (items.length > 0) {
    console.log(
      'First Apify item keys:',
      Object.keys(items[0])
    );

    console.log(
      'First Apify item sample:',
      JSON.stringify(items[0], null, 2).slice(0, 5000)
    );
  }

  return items;
}

async function extractFrames(videoPath, workDir) {
  const framesDir = path.join(workDir, 'frames');

  fs.mkdirSync(framesDir, { recursive: true });

  let duration = null;

  try {
    const result = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        videoPath
      ],
      {
        timeout: 30000
      }
    );

    const parsed = Number(
      String(result.stdout || '').trim()
    );

    if (Number.isFinite(parsed) && parsed > 0) {
      duration = parsed;
    }
  } catch (error) {
    console.warn(
      'ffprobe duration failed:',
      error.message
    );
  }

  const framePaths = [];

  if (duration) {
    const percentages = [0.08, 0.35, 0.65, 0.92];

    for (let i = 0; i < percentages.length; i++) {
      const timestamp = Math.max(
        0,
        Math.min(
          duration - 0.1,
          duration * percentages[i]
        )
      );

      const output = path.join(
        framesDir,
        `frame-${i + 1}.jpg`
      );

      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(timestamp),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          'scale=512:-2',
          '-q:v',
          '6',
          output
        ],
        {
          timeout: 30000
        }
      );

      if (fs.existsSync(output)) {
        framePaths.push(output);
      }
    }
  }

  if (framePaths.length < 2) {
    for (let i = 0; i < 4; i++) {
      const output = path.join(
        framesDir,
        `fallback-${i + 1}.jpg`
      );

      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-i',
            videoPath,
            '-vf',
            'fps=1/4,scale=512:-2',
            '-frames:v',
            '1',
            '-q:v',
            '6',
            output
          ],
          {
            timeout: 30000
          }
        );

        if (fs.existsSync(output)) {
          framePaths.push(output);
        }
      } catch (_) {}
    }
  }

  if (!framePaths.length) {
    throw new Error(
      'FFmpeg could not extract frames from the Reel.'
    );
  }

  return framePaths.slice(0, 4);
}

function parseAiJson(content) {
  let text = String(content || '').trim();

  text = text
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  try {
    return JSON.parse(text);
  } catch (_) {}

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');

  if (start !== -1 && end > start) {
    try {
      return JSON.parse(
        text.slice(start, end + 1)
      );
    } catch (_) {}
  }

  throw new Error(
    'AI returned invalid JSON.'
  );
}

async function analyzeWithOpenRouter(
  framePaths,
  reel
) {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured on Render.'
    );
  }

  const images = framePaths.map((filePath) => ({
    type: 'image_url',
    image_url: {
      url:
        'data:image/jpeg;base64,' +
        fs
          .readFileSync(filePath)
          .toString('base64')
    }
  }));

  const prompt = `
Analyze this Instagram Reel for a short-form content remix workflow.

Reel caption:
${reel.title || '(no caption)'}

Return ONLY valid JSON in exactly this structure:

{
  "summary": "short description of what happens in the Reel",
  "hooks": [
    "hook 1",
    "hook 2",
    "hook 3",
    "hook 4",
    "hook 5"
  ],
  "caption": "short English caption for the remixed Reel"
}

Rules:
- Exactly 5 hooks.
- Each hook must be 12 words or fewer.
- Hooks must be attention-grabbing and suitable as on-screen text.
- Do not invent facts that are not visible or supported by the Reel.
- Caption must be in English.
- No markdown.
`;

  const body = {
    model: OPENROUTER_MODEL,
    messages: [
      {
        role: 'system',
        content:
          'You analyze short-form videos. Always return valid JSON only.'
      },
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: prompt
          },
          ...images
        ]
      }
    ],
    temperature: 0.4,
    max_tokens: 700,
    response_format: {
      type: 'json_object'
    }
  };

  const response = await requestJson(
    'https://openrouter.ai/api/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization:
          `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer':
          'https://squin1983.github.io/Clipper/',
        'X-Title': 'Clipper',
      },
      body: JSON.stringify(body),
      timeout: 90000
    }
  );

  const content =
    response?.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(
      'OpenRouter returned no AI content.'
    );
  }

  return parseAiJson(content);
}

function normalizeHooks(hooks) {
  if (!Array.isArray(hooks)) {
    return [];
  }

  return hooks
    .map((hook) => String(hook || '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

function normalizeAiResult(result) {
  const hooks = normalizeHooks(result?.hooks);

  while (hooks.length < 5) {
    hooks.push('');
  }

  return {
    summary:
      String(result?.summary || '').trim(),
    hooks,
    caption:
      String(result?.caption || '').trim()
  };
}

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: VERSION,
    model: OPENROUTER_MODEL,
    apifyPostsPerProfile:
      APIFY_POSTS_PER_PROFILE,
    time: new Date().toISOString()
  });
});

app.get('/api/accounts', (req, res) => {
  const db = loadDb();
  res.json(db.accounts);
});

app.post('/api/accounts', (req, res) => {
  try {
    const db = loadDb();
    const username = cleanUsername(
      req.body?.username
    );

    if (!username) {
      return res.status(400).json({
        error: 'Instagram username is required.'
      });
    }

    const existing = db.accounts.find(
      (account) =>
        account.username.toLowerCase() ===
        username.toLowerCase()
    );

    if (existing) {
      return res.json(existing);
    }

    const account = {
      id: id(),
      username,
      createdAt: new Date().toISOString()
    };

    db.accounts.push(account);
    saveDb(db);

    res.json(account);
  } catch (error) {
    console.error('Create account error:', error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    const db = loadDb();

    const accountId = req.params.id;

    db.accounts = db.accounts.filter(
      (account) => account.id !== accountId
    );

    db.reels = db.reels.filter(
      (reel) => reel.accountId !== accountId
    );

    db.batches = db.batches.filter(
      (batch) => batch.accountId !== accountId
    );

    saveDb(db);

    res.json({ ok: true });
  } catch (error) {
    console.error('Delete account error:', error);

    res.status(500).json({
      error: error.message
    });
  }
});

app.post('/api/accounts/:id/sync', async (req, res) => {
  try {
    const db = loadDb();

    const account = db.accounts.find(
      (item) => item.id === req.params.id
    );

    if (!account) {
      return res.status(404).json({
        error: 'Instagram account not found.'
      });
    }

    const items = await runApifyProfile(
      account.username
    );

    let added = 0;
    let skipped = 0;

    for (const item of items) {
      const instagramUrl =
        getInstagramUrl(item);

      const shortcode =
        getShortcode(item);

      if (
        !instagramUrl &&
        !shortcode
      ) {
        skipped++;
        continue;
      }

      if (
        isDuplicateReel(
          db,
          instagramUrl,
          shortcode
        )
      ) {
        skipped++;
        continue;
      }

      const reel = {
        id: id(),
        accountId: account.id,
        accountUsername: account.username,
        shortcode:
          shortcode ||
          getSourceId(item) ||
          null,
        instagramUrl:
          instagramUrl ||
          null,
        videoUrl:
          getVideoUrl(item),
        thumbnailUrl:
          getThumbnailUrl(item),
        publishedAt:
          normalizeReelDate(item),
        title:
          getCaption(item),
        duration:
          getDuration(item),
        used: false,
        analyzed: false,
        analysis: null,
        selectedHook: null,
        aiCaption: null,
        rendered: false,
        renderedAt: null,
        createdAt:
          new Date().toISOString(),
        source: 'apify'
      };

      db.reels.push(reel);
      added++;
    }

    saveDb(db);

    const dates = db.reels
      .filter(
        (reel) =>
          reel.accountId === account.id &&
          reel.publishedAt
      )
      .map((reel) =>
        new Date(reel.publishedAt).getTime()
      )
      .filter(Number.isFinite);

    res.json({
      ok: true,
      account,
      fetched: items.length,
      added,
      skipped,
      oldestReturned:
        dates.length
          ? new Date(
              Math.min(...dates)
            ).toISOString()
          : null,
      newestReturned:
        dates.length
          ? new Date(
              Math.max(...dates)
            ).toISOString()
          : null
    });
  } catch (error) {
    console.error(
      'Instagram sync error:',
      error
    );

    res.status(500).json({
      error:
        error.message ||
        'Instagram sync failed.'
    });
  }
});

app.get('/api/reels', (req, res) => {
  const db = loadDb();

  const limit = Math.min(
    Number(req.query.limit) || 500,
    1000
  );

  const reels = [...db.reels]
    .sort((a, b) => {
      const dateA = a.publishedAt
        ? new Date(a.publishedAt).getTime()
        : 0;

      const dateB = b.publishedAt
        ? new Date(b.publishedAt).getTime()
        : 0;

      return dateA - dateB;
    })
    .slice(0, limit);

  res.json(reels);
});

app.get('/api/batches', (req, res) => {
  const db = loadDb();

  res.json(
    [...db.batches].sort(
      (a, b) =>
        new Date(b.createdAt) -
        new Date(a.createdAt)
    )
  );
});

app.get('/api/batch/random', (req, res) => {
  const db = loadDb();

  const accountId =
    req.query.accountId;

  const limit = Math.min(
    Number(req.query.limit) || 10,
    50
  );

  if (!accountId) {
    return res.status(400).json({
      error: 'accountId is required.'
    });
  }

  const reels = db.reels
    .filter(
      (reel) =>
        reel.accountId === accountId &&
        !reel.used
    )
    .sort((a, b) => {
      const dateA = a.publishedAt
        ? new Date(a.publishedAt).getTime()
        : Infinity;

      const dateB = b.publishedAt
        ? new Date(b.publishedAt).getTime()
        : Infinity;

      return dateA - dateB;
    })
    .slice(0, limit);

  const batch = {
    id: id(),
    accountId,
    reelIds: reels.map(
      (reel) => reel.id
    ),
    createdAt:
      new Date().toISOString()
  };

  db.batches.push(batch);
  saveDb(db);

  res.json({
    batch,
    reels
  });
});

app.post('/api/reels/:id/analyze', async (req, res) => {
  let workDir = null;

  try {
    const db = loadDb();

    const reel = db.reels.find(
      (item) => item.id === req.params.id
    );

    if (!reel) {
      return res.status(404).json({
        error: 'Reel not found.'
      });
    }

    if (!reel.videoUrl) {
      return res.status(400).json({
        error:
          'This Reel has no downloadable video URL.'
      });
    }

    if (!OPENROUTER_API_KEY) {
      return res.status(500).json({
        error:
          'OPENROUTER_API_KEY is missing on Render.'
      });
    }

    workDir = path.join(
      '/tmp',
      `clipper-ai-${id()}`
    );

    fs.mkdirSync(workDir, {
      recursive: true
    });

    const videoPath = path.join(
      workDir,
      'reel.mp4'
    );

    console.log(
      `Downloading Reel ${reel.id} for AI analysis`
    );

    await downloadFile(
      reel.videoUrl,
      videoPath
    );

    const framePaths =
      await extractFrames(
        videoPath,
        workDir
      );

    console.log(
      `Sending ${framePaths.length} frames to OpenRouter`
    );

    const result =
      await analyzeWithOpenRouter(
        framePaths,
        reel
      );

    const analysis =
      normalizeAiResult(result);

    reel.analyzed = true;
    reel.analysis = analysis;
    reel.selectedHook =
      analysis.hooks.find(Boolean) ||
      null;
    reel.aiCaption =
      analysis.caption || null;

    saveDb(db);

    res.json({
      ok: true,
      reel
    });
  } catch (error) {
    console.error(
      'AI analysis error:',
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
        fs.rmSync(workDir, {
          recursive: true,
          force: true
        });
      } catch (_) {}
    }
  }
});

app.post('/api/jobs/:id/render', async (req, res) => {
  let jobId = null;
  let workDir = null;

  try {
    const db = loadDb();

    const reel = db.reels.find(
      (item) => item.id === req.params.id
    );

    if (!reel) {
      return res.status(404).json({
        error: 'Reel not found.'
      });
    }

    if (!reel.videoUrl) {
      return res.status(400).json({
        error:
          'This Reel has no downloadable video URL.'
      });
    }

    const hook = String(
      req.body?.hook ||
        reel.selectedHook ||
        ''
    ).trim();

    if (!hook) {
      return res.status(400).json({
        error:
          'A hook is required before rendering.'
      });
    }

    const category =
      String(
        req.body?.category ||
          'music'
      ).trim();

    jobId = id();

    const job = {
      id: jobId,
      reelId: reel.id,
      status: 'processing',
      category,
      hook,
      outputPath: null,
      previewUrl: null,
      error: null,
      createdAt:
        new Date().toISOString(),
      completedAt: null
    };

    db.jobs.push(job);
    saveDb(db);

    workDir = path.join(
      '/tmp',
      `clipper-render-${jobId}`
    );

    fs.mkdirSync(workDir, {
      recursive: true
    });

    const inputPath = path.join(
      workDir,
      'input.mp4'
    );

    const outputPath = path.join(
      RENDER_DIR,
      `${safeFileName(jobId)}.mp4`
    );

    await downloadFile(
      reel.videoUrl,
      inputPath
    );

    let background = 'black';
    let textColor = 'white';

    if (
      category === 'movie_tv'
    ) {
      background = 'white';
      textColor = 'black';
    }

    const escapedHook = hook
      .replace(/\\/g, '\\\\')
      .replace(/:/g, '\\:')
      .replace(/'/g, "\\'")
      .replace(/%/g, '\\%');

    const filter =
      `scale=1080:1920:force_original_aspect_ratio=decrease,` +
      `pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=${background},` +
      `drawtext=text='${escapedHook}':` +
      `fontcolor=${textColor}:` +
      `fontsize=58:` +
      `font='Arial':` +
      `x=(w-text_w)/2:` +
      `y=150:` +
      `box=1:` +
      `boxcolor=${background}@0.85:` +
      `boxborderw=24`;

    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        inputPath,
        '-vf',
        filter,
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
      ],
      {
        timeout: 240000
      }
    );

    if (
      !fs.existsSync(outputPath)
    ) {
      throw new Error(
        'FFmpeg finished but no output file was created.'
      );
    }

    job.status = 'completed';
    job.outputPath = outputPath;
    job.previewUrl =
      `/api/jobs/${jobId}/file`;
    job.completedAt =
      new Date().toISOString();

    reel.used = true;
    reel.rendered = true;
    reel.renderedAt =
      new Date().toISOString();
    reel.selectedHook = hook;

    saveDb(db);

    res.json({
      ok: true,
      job
    });
  } catch (error) {
    console.error(
      'Render error:',
      error
    );

    if (jobId) {
      try {
        const db = loadDb();

        const job = db.jobs.find(
          (item) =>
            item.id === jobId
        );

        if (job) {
          job.status = 'failed';
          job.error =
            error.message ||
            'Render failed.';
          job.completedAt =
            new Date().toISOString();

          saveDb(db);
        }
      } catch (dbError) {
        console.error(
          'Could not update failed job:',
          dbError.message
        );
      }
    }

    res.status(500).json({
      error:
        error.message ||
        'Render failed.'
    });
  } finally {
    if (workDir) {
      try {
        fs.rmSync(workDir, {
          recursive: true,
          force: true
        });
      } catch (_) {}
    }
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const db = loadDb();

  const job = db.jobs.find(
    (item) => item.id === req.params.id
  );

  if (!job) {
    return res.status(404).json({
      error: 'Job not found.'
    });
  }

  res.json(job);
});

app.get('/api/jobs/:id/file', (req, res) => {
  const db = loadDb();

  const job = db.jobs.find(
    (item) => item.id === req.params.id
  );

  if (!job || !job.outputPath) {
    return res.status(404).json({
      error: 'Rendered file not found.'
    });
  }

  if (
    !fs.existsSync(job.outputPath)
  ) {
    return res.status(404).json({
      error:
        'Rendered file no longer exists.'
    });
  }

  res.download(
    job.outputPath,
    'clipper-reel.mp4'
  );
});

app.listen(PORT, () => {
  console.log(
    `Clipper backend v${VERSION} running on port ${PORT}`
  );

  console.log(
    `OpenRouter model: ${OPENROUTER_MODEL}`
  );

  console.log(
    `Apify posts per profile: ${APIFY_POSTS_PER_PROFILE}`
  );
});
