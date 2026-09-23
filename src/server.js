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

const VERSION = '1.6';

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';

const APIFY_ACTOR =
  process.env.APIFY_ACTOR ||
  'instagram-scraper~instagram-profile-reels-scraper';

const APIFY_POSTS_PER_PROFILE = Number(
  process.env.APIFY_POSTS_PER_PROFILE || 500
);

const OPENROUTER_API_KEY =
  process.env.OPENROUTER_API_KEY || '';

const OPENROUTER_MODEL =
  process.env.OPENROUTER_MODEL ||
  'openrouter/free';

const DB_FILE =
  process.env.CLIPPER_DB_FILE ||
  '/tmp/clipper-db.json';

const RENDER_DIR =
  process.env.CLIPPER_RENDER_DIR ||
  '/tmp/clipper-renders';

fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
fs.mkdirSync(RENDER_DIR, { recursive: true });

/* =========================================================
   DATABASE
========================================================= */

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

    const raw = fs.readFileSync(DB_FILE, 'utf8');

    if (!raw.trim()) {
      return createEmptyDb();
    }

    const parsed = JSON.parse(raw);

    return {
      accounts: Array.isArray(parsed.accounts)
        ? parsed.accounts
        : [],

      reels: Array.isArray(parsed.reels)
        ? parsed.reels
        : [],

      batches: Array.isArray(parsed.batches)
        ? parsed.batches
        : [],

      jobs: Array.isArray(parsed.jobs)
        ? parsed.jobs
        : []
    };
  } catch (error) {
    console.error('Database load error:', error.message);
    return createEmptyDb();
  }
}

function saveDb(db) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(db, null, 2),
    'utf8'
  );
}

let db = loadDb();

/* =========================================================
   HELPERS
========================================================= */

function id(prefix = '') {
  return (
    prefix +
    crypto.randomBytes(8).toString('hex')
  );
}

function nowIso() {
  return new Date().toISOString();
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

function normalizeUsername(username) {
  return String(username || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
}

function parseDate(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function safeJsonParse(value) {
  if (typeof value !== 'string') {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/* =========================================================
   HTTP
========================================================= */

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);

    const isHttps = target.protocol === 'https:';

    const transport = isHttps ? https : http;

    const requestOptions = {
      method: options.method || 'GET',
      hostname: target.hostname,
      port:
        target.port ||
        (isHttps ? 443 : 80),
      path:
        target.pathname +
        target.search,
      headers: {
        ...(options.headers || {})
      }
    };

    const request = transport.request(
      requestOptions,
      (response) => {
        let body = '';

        response.setEncoding('utf8');

        response.on('data', (chunk) => {
          body += chunk;
        });

        response.on('end', () => {
          const statusCode =
            response.statusCode || 0;

          if (
            statusCode < 200 ||
            statusCode >= 300
          ) {
            reject(
              new Error(
                `HTTP ${statusCode}: ${body.slice(0, 2000)}`
              )
            );

            return;
          }

          try {
            resolve(
              body
                ? JSON.parse(body)
                : null
            );
          } catch (error) {
            reject(
              new Error(
                `Invalid JSON response: ${body.slice(
                  0,
                  2000
                )}`
              )
            );
          }
        });
      }
    );

    const timeout =
      Number(options.timeout) || 60000;

    request.setTimeout(timeout, () => {
      request.destroy(
        new Error(
          `Request timed out after ${timeout}ms`
        )
      );
    });

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

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);

    const transport =
      target.protocol === 'https:'
        ? https
        : http;

    const file =
      fs.createWriteStream(destination);

    const request = transport.get(
      {
        hostname: target.hostname,
        port:
          target.port ||
          (target.protocol === 'https:'
            ? 443
            : 80),
        path:
          target.pathname +
          target.search,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',
          Accept: '*/*'
        }
      },
      (response) => {
        const statusCode =
          response.statusCode || 0;

        if (
          statusCode >= 300 &&
          statusCode < 400 &&
          response.headers.location
        ) {
          file.close();

          try {
            fs.unlinkSync(destination);
          } catch {}

          downloadFile(
            response.headers.location,
            destination
          )
            .then(resolve)
            .catch(reject);

          return;
        }

        if (
          statusCode < 200 ||
          statusCode >= 300
        ) {
          file.destroy();

          reject(
            new Error(
              `Download failed with HTTP ${statusCode}`
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

    request.setTimeout(
      120000,
      () => {
        request.destroy(
          new Error(
            'Download timed out'
          )
        );
      }
    );

    request.on('error', (error) => {
      file.destroy();

      try {
        fs.unlinkSync(destination);
      } catch {}

      reject(error);
    });
  });
}

/* =========================================================
   APIFY FIELD EXTRACTION
========================================================= */

function getReelUrl(item) {
  return firstNonEmpty(
    item.url,
    item.webUrl,
    item.postUrl,
    item.shortcode
      ? `https://www.instagram.com/reel/${item.shortcode}/`
      : null,
    item.code
      ? `https://www.instagram.com/reel/${item.code}/`
      : null,
    item.permalink
  );
}

function getVideoUrl(item) {
  const videoObject =
    item.video &&
    typeof item.video === 'object'
      ? item.video
      : null;

  return firstNonEmpty(
    item.videoUrl,
    item.video_url,
    item.downloadUrl,
    item.download_url,
    item.mediaUrl,
    item.media_url,

    videoObject?.url,
    videoObject?.videoUrl,
    videoObject?.downloadUrl,

    typeof item.video === 'string'
      ? item.video
      : null,

    item.displayUrl,
    item.display_url
  );
}

function getCaption(item) {
  return firstNonEmpty(
    item.caption,
    item.text,
    item.description,
    item.title,
    ''
  );
}

function getThumbnail(item) {
  return firstNonEmpty(
    item.thumbnailUrl,
    item.thumbnail_url,
    item.displayUrl,
    item.display_url,
    item.imageUrl,
    item.image_url
  );
}

function getUsername(item, fallback) {
  return normalizeUsername(
    firstNonEmpty(
      item.username,
      item.ownerUsername,
      item.owner?.username,
      fallback
    )
  );
}

function getTimestamp(item) {
  return parseDate(
    firstNonEmpty(
      item.timestamp,
      item.takenAt,
      item.taken_at,
      item.publishedAt,
      item.published_at,
      item.date
    )
  );
}

function getShortcode(item) {
  return firstNonEmpty(
    item.shortCode,
    item.shortcode,
    item.code
  );
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

  const normalizedUsername =
    normalizeUsername(username);

  if (!normalizedUsername) {
    throw new Error(
      'Instagram username is empty.'
    );
  }

  const input = {
    instagramUsernames: [
      normalizedUsername
    ],
    postsPerProfile:
      APIFY_POSTS_PER_PROFILE
  };

  console.log(
    `Starting Apify for @${normalizedUsername}, postsPerProfile=${APIFY_POSTS_PER_PROFILE}`
  );

  const startUrl =
    `https://api.apify.com/v2/acts/${encodeURIComponent(
      APIFY_ACTOR
    )}/runs` +
    `?token=${encodeURIComponent(
      APIFY_TOKEN
    )}`;

  const startResponse =
    await requestJson(startUrl, {
      method: 'POST',

      headers: {
        'Content-Type':
          'application/json'
      },

      body: JSON.stringify(input),

      timeout: 60000
    });

  const runDataFromStart =
    startResponse?.data ||
    startResponse;

  const runId =
    runDataFromStart?.id;

  if (!runId) {
    throw new Error(
      'Apify did not return a run ID.'
    );
  }

  console.log(
    `Apify run started: ${runId}`
  );

  /*
   * IMPORTANT:
   *
   * Apify documents RUNNING as a normal transitional
   * state. The previous version stopped after 80 × 3 sec
   * and incorrectly treated RUNNING as an error.
   *
   * We now poll for up to 20 minutes.
   *
   * 120 attempts × 10 seconds = 20 minutes.
   */

  const MAX_ATTEMPTS = 120;
  const POLL_INTERVAL_MS = 10000;

  let runData =
    runDataFromStart;

  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    await new Promise(
      (resolve) =>
        setTimeout(
          resolve,
          POLL_INTERVAL_MS
        )
    );

    const statusUrl =
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(
        runId
      )}` +
      `?token=${encodeURIComponent(
        APIFY_TOKEN
      )}`;

    const statusResponse =
      await requestJson(
        statusUrl,
        {
          timeout: 30000
        }
      );

    runData =
      statusResponse?.data ||
      statusResponse;

    const status =
      runData?.status;

    const duration =
      runData?.startedAt
        ? Math.round(
            (
              Date.now() -
              new Date(
                runData.startedAt
              ).getTime()
            ) / 1000
          )
        : null;

    console.log(
      `Apify status ${attempt}/${MAX_ATTEMPTS}: ${status}` +
      (duration !== null
        ? ` (${duration}s)`
        : '')
    );

    if (
      [
        'SUCCEEDED',
        'FAILED',
        'ABORTED',
        'TIMED-OUT'
      ].includes(status)
    ) {
      break;
    }
  }

  if (!runData) {
    throw new Error(
      'No Apify run status received.'
    );
  }

  console.log(
    `Apify final status: ${runData.status}`
  );

  if (
    runData.status === 'RUNNING' ||
    runData.status === 'READY'
  ) {
    throw new Error(
      `Apify run is still ${runData.status} after 20 minutes. Run ID: ${runId}`
    );
  }

  if (
    runData.status !== 'SUCCEEDED'
  ) {
    throw new Error(
      `Apify run ended with status: ${runData.status}. Run ID: ${runId}`
    );
  }

  const datasetId =
    runData.defaultDatasetId;

  if (!datasetId) {
    throw new Error(
      'Apify run completed but no dataset was returned.'
    );
  }

  console.log(
    `Apify dataset: ${datasetId}`
  );

  const datasetUrl =
    `https://api.apify.com/v2/datasets/${encodeURIComponent(
      datasetId
    )}/items` +
    `?token=${encodeURIComponent(
      APIFY_TOKEN
    )}` +
    `&clean=true`;

  const items =
    await requestJson(
      datasetUrl,
      {
        timeout: 120000
      }
    );

  if (!Array.isArray(items)) {
    throw new Error(
      'Apify returned an invalid dataset.'
    );
  }

  console.log(
    `Apify returned ${items.length} items for @${normalizedUsername}`
  );

  if (items.length > 0) {
    console.log(
      'First Apify item keys:',
      Object.keys(items[0])
    );

    console.log(
      'First Apify item sample:',
      JSON.stringify(
        items[0],
        null,
        2
      ).slice(0, 5000)
    );
  }

  return items;
}

/* =========================================================
   FRAME EXTRACTION
========================================================= */

async function extractFrames(
  videoPath,
  workDir
) {
  const framesDir =
    path.join(
      workDir,
      'frames'
    );

  fs.mkdirSync(
    framesDir,
    {
      recursive: true
    }
  );

  let duration = null;

  try {
    const result =
      await execFileAsync(
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

    const parsed =
      Number(
        String(
          result.stdout || ''
        ).trim()
      );

    if (
      Number.isFinite(parsed) &&
      parsed > 0
    ) {
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
    const percentages = [
      0.08,
      0.35,
      0.65,
      0.92
    ];

    for (
      let i = 0;
      i < percentages.length;
      i++
    ) {
      const timestamp =
        Math.max(
          0,
          Math.min(
            duration - 0.1,
            duration *
              percentages[i]
          )
        );

      const output =
        path.join(
          framesDir,
          `frame-${i + 1}.jpg`
        );

      try {
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

        if (
          fs.existsSync(output)
        ) {
          framePaths.push(
            output
          );
        }
      } catch (error) {
        console.warn(
          `Frame ${i + 1} extraction failed:`,
          error.message
        );
      }
    }
  }

  if (
    framePaths.length < 2
  ) {
    const fallback =
      path.join(
        framesDir,
        'fallback.jpg'
      );

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-vf',
          'scale=512:-2',
          '-q:v',
          '6',
          fallback
        ],
        {
          timeout: 30000
        }
      );

      if (
        fs.existsSync(fallback)
      ) {
        framePaths.push(
          fallback
        );
      }
    } catch (error) {
      console.warn(
        'Fallback frame extraction failed:',
        error.message
      );
    }
  }

  return framePaths;
}

/* =========================================================
   IMAGE -> DATA URL
========================================================= */

function imageToDataUrl(
  filePath
) {
  const buffer =
    fs.readFileSync(
      filePath
    );

  return (
    'data:image/jpeg;base64,' +
    buffer.toString('base64')
  );
}

/* =========================================================
   OPENROUTER
========================================================= */

async function analyzeVideoWithAI(
  videoPath,
  caption
) {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      'OPENROUTER_API_KEY is not configured on Render.'
    );
  }

  const workDir =
    fs.mkdtempSync(
      path.join(
        '/tmp/',
        'clipper-ai-'
      )
    );

  try {
    const frames =
      await extractFrames(
        videoPath,
        workDir
      );

    if (!frames.length) {
      throw new Error(
        'Could not extract frames from video.'
      );
    }

    const imageParts =
      frames.map(
        (framePath) => ({
          type: 'image_url',
          image_url: {
            url:
              imageToDataUrl(
                framePath
              )
          }
        })
      );

    const prompt = `
You are analyzing an Instagram Reel for a social-media remix workflow.

Return ONLY valid JSON.

Analyze the provided video frames and caption.

The JSON must contain exactly these fields:

{
  "summary": "short factual summary of what happens",
  "hook": "the strongest short hook for a Reel",
  "hookAlternatives": [
    "alternative hook 1",
    "alternative hook 2",
    "alternative hook 3"
  ],
  "onScreenText": "short viral-style English text",
  "caption": "short English Instagram caption",
  "hashtags": [
    "#hashtag1",
    "#hashtag2",
    "#hashtag3"
  ],
  "tone": "description of tone",
  "topics": [
    "topic1",
    "topic2"
  ]
}

Rules:
- English only.
- Do not invent facts that are not visible or stated.
- Keep hooks short.
- Make on-screen text suitable for a Reel.
- Do not use quotation marks around the hook.
- Avoid generic filler.
- Focus on the actual moment shown.

Original Instagram caption:
${caption || ''}
`;

    const response =
      await requestJson(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${OPENROUTER_API_KEY}`,

            'HTTP-Referer':
              'https://squin1983.github.io/Clipper/',

            'X-Title':
              'Clipper'
          },

          body: JSON.stringify({
            model:
              OPENROUTER_MODEL,

            messages: [
              {
                role: 'user',

                content: [
                  {
                    type: 'text',
                    text: prompt
                  },
                  ...imageParts
                ]
              }
            ],

            response_format: {
              type: 'json_object'
            }
          }),

          timeout: 120000
        }
      );

    const content =
      response?.choices?.[0]
        ?.message?.content;

    if (!content) {
      throw new Error(
        'OpenRouter returned no AI content.'
      );
    }

    let parsed =
      safeJsonParse(
        content
      );

    if (!parsed) {
      const match =
        content.match(
          /\{[\s\S]*\}/
        );

      if (match) {
        parsed =
          safeJsonParse(
            match[0]
          );
      }
    }

    if (!parsed) {
      throw new Error(
        'OpenRouter returned invalid JSON.'
      );
    }

    return parsed;
  } finally {
    try {
      fs.rmSync(
        workDir,
        {
          recursive: true,
          force: true
        }
      );
    } catch {}
  }
}

/* =========================================================
   HEALTH
========================================================= */

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok: true,
      version: VERSION,
      model: OPENROUTER_MODEL,
      apifyPostsPerProfile:
        APIFY_POSTS_PER_PROFILE,
      time: nowIso()
    });
  }
);

/* =========================================================
   ACCOUNTS
========================================================= */

app.get(
  '/api/accounts',
  (req, res) => {
    res.json({
      accounts: db.accounts
    });
  }
);

app.post(
  '/api/accounts',
  (req, res) => {
    try {
      const username =
        normalizeUsername(
          req.body?.username
        );

      if (!username) {
        return res.status(400).json({
          error:
            'Instagram username is required.'
        });
      }

      const existing =
        db.accounts.find(
          (account) =>
            account.username ===
            username
        );

      if (existing) {
        return res.json({
          account: existing
        });
      }

      const account = {
        id: id('acc_'),
        username,
        createdAt: nowIso(),
        updatedAt: nowIso()
      };

      db.accounts.push(
        account
      );

      saveDb(db);

      res.status(201).json({
        account
      });
    } catch (error) {
      console.error(
        'Create account error:',
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

app.delete(
  '/api/accounts/:id',
  (req, res) => {
    try {
      const accountId =
        req.params.id;

      db.accounts =
        db.accounts.filter(
          (account) =>
            account.id !==
            accountId
        );

      db.reels =
        db.reels.filter(
          (reel) =>
            reel.accountId !==
            accountId
        );

      db.batches =
        db.batches.filter(
          (batch) =>
            batch.accountId !==
            accountId
        );

      saveDb(db);

      res.json({
        ok: true
      });
    } catch (error) {
      console.error(
        'Delete account error:',
        error
      );

      res.status(500).json({
        error:
          error.message
      });
    }
  }
);

/* =========================================================
   SYNC INSTAGRAM
========================================================= */

app.post(
  '/api/accounts/:id/sync',
  async (req, res) => {
    try {
      const account =
        db.accounts.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!account) {
        return res.status(404).json({
          error:
            'Instagram account not found.'
        });
      }

      console.log(
        `Starting Instagram sync for @${account.username}`
      );

      const items =
        await runApifyProfile(
          account.username
        );

      let added = 0;
      let updated = 0;

      for (const item of items) {
        const reelUrl =
          getReelUrl(item);

        if (!reelUrl) {
          continue;
        }

        const videoUrl =
          getVideoUrl(item);

        const shortcode =
          getShortcode(item);

        const externalId =
          firstNonEmpty(
            item.id,
            item.pk,
            shortcode,
            reelUrl
          );

        const existing =
          db.reels.find(
            (reel) =>
              reel.accountId ===
                account.id &&
              (
                reel.externalId ===
                  externalId ||
                reel.url ===
                  reelUrl
              )
          );

        const reelData = {
          accountId:
            account.id,

          username:
            getUsername(
              item,
              account.username
            ),

          externalId,

          shortcode,

          url:
            reelUrl,

          videoUrl,

          thumbnailUrl:
            getThumbnail(item),

          caption:
            getCaption(item),

          publishedAt:
            getTimestamp(item),

          updatedAt:
            nowIso(),

          raw:
            item
        };

        if (existing) {
          Object.assign(
            existing,
            reelData
          );

          updated++;
        } else {
          db.reels.push({
            id:
              id('reel_'),

            ...reelData,

            createdAt:
              nowIso(),

            analysis:
              null,

            selectedHook:
              null,

            render:
              null
          });

          added++;
        }
      }

      account.updatedAt =
        nowIso();

      saveDb(db);

      console.log(
        `Instagram sync complete for @${account.username}: added=${added}, updated=${updated}, total=${items.length}`
      );

      res.json({
        ok: true,

        account,

        added,

        updated,

        total:
          items.length,

        reels:
          db.reels.filter(
            (reel) =>
              reel.accountId ===
              account.id
          )
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
  }
);

/* =========================================================
   REELS
========================================================= */

app.get(
  '/api/accounts/:id/reels',
  (req, res) => {
    const reels =
      db.reels
        .filter(
          (reel) =>
            reel.accountId ===
            req.params.id
        )
        .sort(
          (a, b) =>
            new Date(
              b.publishedAt ||
                b.createdAt
            ) -
            new Date(
              a.publishedAt ||
                a.createdAt
            )
        );

    res.json({
      reels
    });
  }
);

app.get(
  '/api/batch/random',
  (req, res) => {
    const accountId =
      req.query.accountId;

    const limit =
      Math.min(
        Number(
          req.query.limit || 10
        ),
        100
      );

    let reels =
      db.reels.filter(
        (reel) =>
          !accountId ||
          reel.accountId ===
            accountId
      );

    reels =
      reels.sort(
        () =>
          Math.random() - 0.5
      );

    res.json({
      reels:
        reels.slice(
          0,
          limit
        )
    });
  }
);

/* =========================================================
   ANALYZE REEL
========================================================= */

app.post(
  '/api/reels/:id/analyze',
  async (req, res) => {
    const reel =
      db.reels.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!reel) {
      return res.status(404).json({
        error:
          'Reel not found.'
      });
    }

    if (!reel.videoUrl) {
      return res.status(400).json({
        error:
          'This Reel does not have a downloadable video URL.'
      });
    }

    const workDir =
      fs.mkdtempSync(
        path.join(
          '/tmp/',
          'clipper-video-'
        )
      );

    const videoPath =
      path.join(
        workDir,
        'source.mp4'
      );

    try {
      console.log(
        `Downloading Reel video for ${reel.id}`
      );

      await downloadFile(
        reel.videoUrl,
        videoPath
      );

      console.log(
        `Analyzing Reel ${reel.id} with OpenRouter`
      );

      const analysis =
        await analyzeVideoWithAI(
          videoPath,
          reel.caption
        );

      reel.analysis =
        analysis;

      reel.updatedAt =
        nowIso();

      saveDb(db);

      res.json({
        ok: true,
        reel
      });
    } catch (error) {
      console.error(
        'Analyze error:',
        error
      );

      res.status(500).json({
        error:
          error.message ||
          'Reel analysis failed.'
      });
    } finally {
      try {
        fs.rmSync(
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

/* =========================================================
   SELECT HOOK
========================================================= */

app.post(
  '/api/reels/:id/hook',
  (req, res) => {
    const reel =
      db.reels.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!reel) {
      return res.status(404).json({
        error:
          'Reel not found.'
      });
    }

    const hook =
      String(
        req.body?.hook || ''
      ).trim();

    if (!hook) {
      return res.status(400).json({
        error:
          'Hook is required.'
      });
    }

    reel.selectedHook =
      hook;

    reel.updatedAt =
      nowIso();

    saveDb(db);

    res.json({
      ok: true,
      reel
    });
  }
);

/* =========================================================
   RENDER
========================================================= */

app.post(
  '/api/jobs/:reelId/render',
  async (req, res) => {
    const reel =
      db.reels.find(
        (item) =>
          item.id ===
          req.params.reelId
      );

    if (!reel) {
      return res.status(404).json({
        error:
          'Reel not found.'
      });
    }

    if (!reel.videoUrl) {
      return res.status(400).json({
        error:
          'Reel has no video URL.'
      });
    }

    const jobId =
      id('job_');

    const job = {
      id: jobId,

      reelId:
        reel.id,

      status:
        'queued',

      createdAt:
        nowIso(),

      updatedAt:
        nowIso(),

      outputUrl:
        null,

      error:
        null
    };

    db.jobs.push(job);

    saveDb(db);

    res.json({
      ok: true,
      job
    });

    /*
     * Rendering runs in background.
     * This keeps the API response fast.
     */

    (async () => {
      try {
        job.status =
          'processing';

        job.updatedAt =
          nowIso();

        saveDb(db);

        const workDir =
          fs.mkdtempSync(
            path.join(
              '/tmp/',
              'clipper-render-'
            )
          );

        const sourcePath =
          path.join(
            workDir,
            'source.mp4'
          );

        const outputPath =
          path.join(
            RENDER_DIR,
            `${jobId}.mp4`
          );

        try {
          console.log(
            `Render ${jobId}: downloading source`
          );

          await downloadFile(
            reel.videoUrl,
            sourcePath
          );

          const hook =
            reel.selectedHook ||
            reel.analysis?.hook ||
            '';

          const escapedHook =
            String(hook)
              .replace(
                /\\/g,
                '\\\\'
              )
              .replace(
                /'/g,
                "\\'"
              )
              .replace(
                /:/g,
                '\\:'
              )
              .replace(
                /\[/g,
                '\\['
              )
              .replace(
                /\]/g,
                '\\]'
              );

          /*
           * Basic vertical Reel render.
           *
           * The source is scaled to fill 1080x1920
           * and the selected hook is placed near
           * the top.
           */

          const filter =
            [
              'scale=1080:1920:force_original_aspect_ratio=increase',
              'crop=1080:1920',
              'setsar=1',
              escapedHook
                ? `drawtext=text='${escapedHook}':fontcolor=white:fontsize=58:borderw=4:bordercolor=black:x=(w-text_w)/2:y=140:box=1:boxcolor=black@0.35:boxborderw=20`
                : null
            ]
              .filter(Boolean)
              .join(',');

          console.log(
            `Render ${jobId}: ffmpeg`
          );

          await execFileAsync(
            'ffmpeg',
            [
              '-y',
              '-i',
              sourcePath,
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
              timeout:
                300000
            }
          );

          if (
            !fs.existsSync(
              outputPath
            )
          ) {
            throw new Error(
              'FFmpeg completed but output file was not created.'
            );
          }

          job.status =
            'completed';

          job.outputUrl =
            `/api/jobs/${jobId}/download`;

          job.updatedAt =
            nowIso();

          reel.render = {
            jobId,
            status:
              'completed',
            outputUrl:
              job.outputUrl,
            updatedAt:
              nowIso()
          };

          saveDb(db);

          console.log(
            `Render ${jobId}: completed`
          );
        } finally {
          try {
            fs.rmSync(
              workDir,
              {
                recursive:
                  true,
                force: true
              }
            );
          } catch {}
        }
      } catch (error) {
        console.error(
          `Render ${jobId} failed:`,
          error
        );

        const currentJob =
          db.jobs.find(
            (item) =>
              item.id ===
              jobId
          );

        if (currentJob) {
          currentJob.status =
            'failed';

          currentJob.error =
            error.message;

          currentJob.updatedAt =
            nowIso();
        }

        reel.render = {
          jobId,

          status:
            'failed',

          error:
            error.message,

          updatedAt:
            nowIso()
        };

        saveDb(db);
      }
    })();
  }
);

/* =========================================================
   JOB STATUS
========================================================= */

app.get(
  '/api/jobs/:id',
  (req, res) => {
    const job =
      db.jobs.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error:
          'Job not found.'
      });
    }

    res.json({
      job
    });
  }
);

/* =========================================================
   DOWNLOAD
========================================================= */

app.get(
  '/api/jobs/:id/download',
  (req, res) => {
    const job =
      db.jobs.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!job) {
      return res.status(404).send(
        'Render job not found.'
      );
    }

    if (
      job.status !==
      'completed'
    ) {
      return res.status(409).send(
        'Render is not completed yet.'
      );
    }

    const filePath =
      path.join(
        RENDER_DIR,
        `${job.id}.mp4`
      );

    if (
      !fs.existsSync(
        filePath
      )
    ) {
      return res.status(404).send(
        'Rendered file no longer exists.'
      );
    }

    res.download(
      filePath,
      `clipper-${job.reelId}.mp4`
    );
  }
);

/* =========================================================
   404
========================================================= */

app.use(
  (req, res) => {
    res.status(404).json({
      error:
        'Endpoint not found.',
      path:
        req.path
    });
  }
);

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    console.error(
      'Unhandled server error:',
      error
    );

    if (
      res.headersSent
    ) {
      return next(error);
    }

    res.status(500).json({
      error:
        error.message ||
        'Internal server error.'
    });
  }
);

/* =========================================================
   START
========================================================= */

app.listen(
  PORT,
  '0.0.0.0',
  () => {
    console.log(
      `Clipper backend v${VERSION} listening on port ${PORT}`
    );

    console.log(
      `Apify actor: ${APIFY_ACTOR}`
    );

    console.log(
      `Apify posts per profile: ${APIFY_POSTS_PER_PROFILE}`
    );

    console.log(
      `OpenRouter model: ${OPENROUTER_MODEL}`
    );
  }
);
