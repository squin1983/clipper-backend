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

const VERSION = '2.0.8';

/*
 * ========================================
 * APIFY
 * ========================================
 *
 * V2.0.1 uses cursor-based pagination.
 *
 * Actor:
 * seemuapps~instagram-posts-scraper
 *
 * IMPORTANT:
 * The Actor accepts:
 *
 *   mode = "all"
 *   mode = "reels"
 *
 * For Clipper we use:
 *
 *   mode = "reels"
 *
 * Pagination:
 *
 *   NEXT_PAGE_ID -> pageId
 */

const APIFY_TOKEN =
  process.env.APIFY_TOKEN || '';

/*
 * IMPORTANT:
 * We intentionally hardcode the new
 * cursor-based Actor.
 *
 * This prevents an old Render environment
 * variable from accidentally switching us
 * back to the previous Actor.
 */
const APIFY_ACTOR =
  'seemuapps~instagram-posts-scraper';

/*
 * Exact mode accepted by the Actor.
 */
const APIFY_MODE =
  'reels';

/*
 * Fetch 20 Reels per Sync.
 *
 * Maximum allowed by our Clipper logic:
 * 30.
 */
const APIFY_BATCH_SIZE = Math.min(
  Math.max(
    Number(
      process.env.APIFY_BATCH_SIZE || 20
    ),
    1
  ),
  30
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

fs.mkdirSync(
  path.dirname(DB_FILE),
  {
    recursive: true
  }
);

fs.mkdirSync(
  RENDER_DIR,
  {
    recursive: true
  }
);

/*
 * ========================================
 * DATABASE
 * ========================================
 */

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

    const raw =
      fs.readFileSync(
        DB_FILE,
        'utf8'
      );

    if (!raw.trim()) {
      return createEmptyDb();
    }

    const parsed =
      JSON.parse(raw);

    return {
      accounts:
        Array.isArray(
          parsed.accounts
        )
          ? parsed.accounts
          : [],

      reels:
        Array.isArray(
          parsed.reels
        )
          ? parsed.reels
          : [],

      batches:
        Array.isArray(
          parsed.batches
        )
          ? parsed.batches
          : [],

      jobs:
        Array.isArray(
          parsed.jobs
        )
          ? parsed.jobs
          : []
    };
  } catch (error) {
    console.error(
      'Database load error:',
      error.message
    );

    return createEmptyDb();
  }
}

function saveDb(database) {
  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(
      database,
      null,
      2
    ),
    'utf8'
  );
}

let db = loadDb();

function id(prefix = '') {
  return (
    prefix +
    crypto
      .randomBytes(8)
      .toString('hex')
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

  const date =
    new Date(value);

  if (
    Number.isNaN(
      date.getTime()
    )
  ) {
    return null;
  }

  return date.toISOString();
}

function safeJsonParse(value) {
  if (
    typeof value !==
    'string'
  ) {
    return value;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/*
 * ========================================
 * HTTP HELPERS
 * ========================================
 */

function requestJson(
  url,
  options = {}
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const target =
        new URL(url);

      const isHttps =
        target.protocol ===
        'https:';

      const transport =
        isHttps
          ? https
          : http;

      const requestOptions = {
        method:
          options.method ||
          'GET',

        hostname:
          target.hostname,

        port:
          target.port ||
          (
            isHttps
              ? 443
              : 80
          ),

        path:
          target.pathname +
          target.search,

        headers: {
          ...(options.headers || {})
        }
      };

      const request =
        transport.request(
          requestOptions,
          (response) => {
            let body = '';

            response.setEncoding(
              'utf8'
            );

            response.on(
              'data',
              (chunk) => {
                body += chunk;
              }
            );

            response.on(
              'end',
              () => {
                const statusCode =
                  response.statusCode ||
                  0;

                if (
                  statusCode < 200 ||
                  statusCode >= 300
                ) {
                  reject(
                    new Error(
                      `HTTP ${statusCode}: ${body.slice(
                        0,
                        3000
                      )}`
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
                } catch {
                  reject(
                    new Error(
                      `Invalid JSON response: ${body.slice(
                        0,
                        3000
                      )}`
                    )
                  );
                }
              }
            );
          }
        );

      const timeout =
        Number(
          options.timeout
        ) || 60000;

      request.setTimeout(
        timeout,
        () => {
          request.destroy(
            new Error(
              `Request timed out after ${timeout}ms`
            )
          );
        }
      );

      request.on(
        'error',
        reject
      );

      if (options.body) {
        request.write(
          options.body
        );
      }

      request.end();
    }
  );
}

function downloadFile(
  url,
  destination
) {
  return new Promise(
    (
      resolve,
      reject
    ) => {
      const target =
        new URL(url);

      const transport =
        target.protocol ===
        'https:'
          ? https
          : http;

      const file =
        fs.createWriteStream(
          destination
        );

      const request =
        transport.get(
          {
            hostname:
              target.hostname,

            port:
              target.port ||
              (
                target.protocol ===
                'https:'
                  ? 443
                  : 80
              ),

            path:
              target.pathname +
              target.search,

            headers: {
              'User-Agent':
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36',

              Accept:
                '*/*'
            }
          },

          (response) => {
            const statusCode =
              response.statusCode ||
              0;

            if (
              statusCode >= 300 &&
              statusCode < 400 &&
              response.headers.location
            ) {
              file.close();

              try {
                fs.unlinkSync(
                  destination
                );
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

            file.on(
              'finish',
              () => {
                file.close(
                  resolve
                );
              }
            );
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

      request.on(
        'error',
        (error) => {
          file.destroy();

          try {
            fs.unlinkSync(
              destination
            );
          } catch {}

          reject(error);
        }
      );
    }
  );
}

/*
 * ========================================
 * INSTAGRAM / REEL HELPERS
 * ========================================
 */

function getReelUrl(item) {
  return firstNonEmpty(
    item.postUrl,

    item.url,

    item.webUrl,

    item.permalink,

    item.instagram_url,

    item.shortcode
      ? `https://www.instagram.com/reel/${item.shortcode}/`
      : null,

    item.shortCode
      ? `https://www.instagram.com/reel/${item.shortCode}/`
      : null,

    item.code
      ? `https://www.instagram.com/reel/${item.code}/`
      : null
  );
}

function getVideoUrl(item) {
  const videoObject =
    item.video &&
    typeof item.video ===
      'object'
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

    typeof item.video ===
      'string'
      ? item.video
      : null
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

function getUsername(
  item,
  fallback
) {
  return normalizeUsername(
    firstNonEmpty(
      item.authorUsername,

      item.username,

      item.ownerUsername,

      item.author?.username,

      item.owner?.username,

      fallback
    )
  );
}

function getTimestamp(item) {
  return parseDate(
    firstNonEmpty(
      item.takenAt,

      item.taken_at,

      item.takenAtTimestamp,

      item.timestamp,

      item.publishedAt,

      item.published_at,

      item.date
    )
  );
}

function getShortcode(item) {
  return firstNonEmpty(
    item.shortcode,

    item.shortCode,

    item.code
  );
}

function getExternalId(item) {
  return firstNonEmpty(
    item.postId,

    item.id,

    item.pk,

    getShortcode(item),

    getReelUrl(item)
  );
}

/*
 * ========================================
 * ACCOUNT HELPERS
 * ========================================
 */

function getOldestStoredReel(
  accountId
) {
  const reels =
    db.reels.filter(
      (reel) =>
        reel.accountId ===
        accountId &&
        reel.publishedAt
    );

  if (!reels.length) {
    return null;
  }

  reels.sort(
    (a, b) =>
      new Date(
        a.publishedAt
      ) -
      new Date(
        b.publishedAt
      )
  );

  return reels[0];
}

function getNewestStoredReel(
  accountId
) {
  const reels =
    db.reels.filter(
      (reel) =>
        reel.accountId ===
        accountId &&
        reel.publishedAt
    );

  if (!reels.length) {
    return null;
  }

  reels.sort(
    (a, b) =>
      new Date(
        b.publishedAt
      ) -
      new Date(
        a.publishedAt
      )
  );

  return reels[0];
}

/*
 * ========================================
 * APIFY CURSOR PAGINATION
 * ========================================
 */

async function getApifyNextPageId(
  keyValueStoreId
) {
  if (!keyValueStoreId) {
    throw new Error(
      'Apify did not return defaultKeyValueStoreId, so Clipper cannot retrieve NEXT_PAGE_ID.'
    );
  }

  const url =
    `https://api.apify.com/v2/key-value-stores/${encodeURIComponent(
      keyValueStoreId
    )}/records/NEXT_PAGE_ID` +
    `?token=${encodeURIComponent(
      APIFY_TOKEN
    )}`;

  try {
    const value =
      await requestJson(
        url,
        {
          timeout:
            30000
        }
      );

    if (
      value === null ||
      value === undefined
    ) {
      return null;
    }

    if (
      typeof value ===
      'string'
    ) {
      const trimmed =
        value.trim();

      if (
        !trimmed ||
        trimmed ===
          'null'
      ) {
        return null;
      }

      return trimmed;
    }

    if (
      typeof value ===
      'object'
    ) {
      if (
        typeof value.value ===
        'string'
      ) {
        return value.value;
      }

      if (
        typeof value.pageId ===
        'string'
      ) {
        return value.pageId;
      }

      if (
        typeof value.nextPageId ===
        'string'
      ) {
        return value.nextPageId;
      }

      return null;
    }

    return String(
      value
    );
  } catch (error) {
    if (
      String(
        error.message ||
          ''
      ).includes(
        'HTTP 404'
      )
    ) {
      return null;
    }

    throw error;
  }
}

async function runApify(
  username,
  options = {}
) {
  if (!APIFY_TOKEN) {
    throw new Error(
      'APIFY_TOKEN is not configured on Render.'
    );
  }

  const normalizedUsername =
    normalizeUsername(
      username
    );

  if (!normalizedUsername) {
    throw new Error(
      'Instagram username is empty.'
    );
  }

  /*
   * EXACT INPUT EXPECTED BY THE ACTOR:
   *
   * username
   * mode = "reels"
   * maxPosts
   * pageId (only when continuing)
   */
  const input = {
    username:
      normalizedUsername,

    mode:
      APIFY_MODE,

    maxPosts:
      Math.min(
        Number(
          options.maxPosts ||
            APIFY_BATCH_SIZE
        ),
        30
      )
  };

  if (
    options.pageId
  ) {
    input.pageId =
      String(
        options.pageId
      );
  }

  console.log(
    '=========================================='
  );

  console.log(
    `Starting cursor-based Apify sync for @${normalizedUsername}`
  );

  console.log(
    `Actor: ${APIFY_ACTOR}`
  );

  console.log(
    `Mode: ${APIFY_MODE}`
  );

  console.log(
    `Batch size: ${input.maxPosts}`
  );

  console.log(
    'Apify input:',
    JSON.stringify(
      input
    )
  );

  const startUrl =
    `https://api.apify.com/v2/acts/${encodeURIComponent(
      APIFY_ACTOR
    )}/runs` +
    `?token=${encodeURIComponent(
      APIFY_TOKEN
    )}`;

  const startResponse =
    await requestJson(
      startUrl,
      {
        method:
          'POST',

        headers: {
          'Content-Type':
            'application/json'
        },

        body:
          JSON.stringify(
            input
          ),

        timeout:
          60000
      }
    );

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

  const MAX_ATTEMPTS = 120;

  const POLL_INTERVAL_MS =
    10000;

  let runData =
    runDataFromStart;

  for (
    let attempt = 1;
    attempt <=
      MAX_ATTEMPTS;
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
          timeout:
            30000
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
            ) /
              1000
          )
        : null;

    console.log(
      `Apify status ${attempt}/${MAX_ATTEMPTS}: ${status}` +
        (
          duration !==
          null
            ? ` (${duration}s)`
            : ''
        )
    );

    if (
      [
        'SUCCEEDED',
        'FAILED',
        'ABORTED',
        'TIMED-OUT'
      ].includes(
        status
      )
    ) {
      break;
    }
  }

  if (
    runData?.status ===
      'RUNNING' ||
    runData?.status ===
      'READY'
  ) {
    throw new Error(
      `Apify run is still ${runData.status} after 20 minutes. Run ID: ${runId}`
    );
  }

  /*
   * IMPORTANT:
   * The Apify actor can finish with ABORTED or TIMED-OUT after it has
   * already written useful items to its dataset (for example when the
   * run hits its configured maximum cost). In that case we must still
   * process the dataset and NEXT_PAGE_ID instead of discarding the page.
   *
   * FAILED remains a hard error because it normally indicates that the
   * actor did not complete its work successfully.
   */
  const finalStatus = runData?.status;
  const partialStatuses = [
    'ABORTED',
    'TIMED-OUT'
  ];

  if (
    finalStatus !== 'SUCCEEDED' &&
    !partialStatuses.includes(finalStatus)
  ) {
    throw new Error(
      `Apify run ended with status: ${finalStatus}. Run ID: ${runId}`
    );
  }

  if (partialStatuses.includes(finalStatus)) {
    console.warn(
      `Apify run ended with ${finalStatus}. Processing any dataset items already produced. Run ID: ${runId}`
    );
  }

  console.log(
    `Apify final status: ${finalStatus}`
  );

  const datasetId =
    runData.defaultDatasetId;

  const keyValueStoreId =
    runData.defaultKeyValueStoreId;

  if (!datasetId) {
    throw new Error(
      'Apify run completed but no dataset was returned.'
    );
  }

  console.log(
    `Apify dataset: ${datasetId}`
  );

  console.log(
    `Apify key-value store: ${
      keyValueStoreId ||
      'not returned'
    }`
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
        timeout:
          120000
      }
    );

  if (!Array.isArray(items)) {
    throw new Error(
      'Apify returned an invalid dataset.'
    );
  }

  /*
   * IMPORTANT:
   * Retrieve the cursor only after the
   * actor has completed.
   */
  const nextPageId =
    await getApifyNextPageId(
      keyValueStoreId
    );

  console.log(
    `Apify returned ${items.length} items.`
  );

  console.log(
    `NEXT_PAGE_ID: ${
      nextPageId
        ? `${String(
            nextPageId
          ).slice(0, 30)}...`
        : 'null'
    }`
  );

  if (
    items.length > 0
  ) {
    console.log(
      'First Apify item:',
      JSON.stringify(
        items[0],
        null,
        2
      ).slice(
        0,
        5000
      )
    );
  }

  return {
    items,
    nextPageId,
    runId,
    datasetId,
    keyValueStoreId
  };
}

/*
 * ========================================
 * SAVE / UPSERT APIFY REELS
 * ========================================
 */

function saveApifyItems(
  account,
  items
) {
  let added = 0;
  let updated = 0;
  let duplicates = 0;

  const seenThisRun =
    new Set();

  for (
    const item of items
  ) {
    /*
     * Ignore Apify error records.
     */
    if (
      item?.error
    ) {
      console.warn(
        `Skipping Apify error record: ${item.error}`
      );

      continue;
    }

    /*
     * Actor was requested in Reels mode.
     *
     * If productType exists, make sure
     * we do not accidentally store normal
     * photo posts.
     */
    if (
      item.productType &&
      item.productType !==
        'clips'
    ) {
      console.warn(
        `Skipping non-Reel item: ${item.productType}`
      );

      continue;
    }

    const reelUrl =
      getReelUrl(item);

    if (!reelUrl) {
      console.warn(
        'Skipping Apify item without reel URL.'
      );

      continue;
    }

    const videoUrl =
      getVideoUrl(item);

    const shortcode =
      getShortcode(item);

    const externalId =
      String(
        getExternalId(
          item
        )
      );

    const runKey =
      shortcode ||
      externalId ||
      reelUrl;

    if (
      seenThisRun.has(
        runKey
      )
    ) {
      duplicates++;
      continue;
    }

    seenThisRun.add(
      runKey
    );

    const publishedAt =
      getTimestamp(item);

    const existing =
      db.reels.find(
        (reel) =>
          reel.accountId ===
            account.id &&
          (
            (
              reel.externalId &&
              String(
                reel.externalId
              ) ===
                externalId
            ) ||
            (
              shortcode &&
              reel.shortcode &&
              reel.shortcode ===
                shortcode
            ) ||
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
        getThumbnail(
          item
        ),

      caption:
        getCaption(
          item
        ),

      publishedAt,

      likeCount:
        firstNonEmpty(
          item.likeCount,
          item.likesCount
        ),

      commentCount:
        firstNonEmpty(
          item.commentCount,
          item.commentsCount
        ),

      viewCount:
        firstNonEmpty(
          item.viewCount,
          item.viewsCount
        ),

      playCount:
        firstNonEmpty(
          item.playCount,
          item.playsCount
        ),

      duration:
        firstNonEmpty(
          item.videoDuration,
          item.duration
        ),

      updatedAt:
        nowIso(),

      raw:
        item
    };

    if (existing) {
      /*
       * Preserve AI analysis,
       * selected hook and render.
       */
      const existingAnalysis =
        existing.analysis;

      const existingSelectedHook =
        existing.selectedHook;

      const existingRender =
        existing.render;

      Object.assign(
        existing,
        reelData
      );

      existing.analysis =
        existingAnalysis ||
        null;

      existing.selectedHook =
        existingSelectedHook ||
        null;

      existing.render =
        existingRender ||
        null;

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

  return {
    added,
    updated,
    duplicates
  };
}

/*
 * ========================================
 * HEALTH
 * ========================================
 */

app.get(
  '/api/health',
  (req, res) => {
    res.json({
      ok:
        true,

      version:
        VERSION,

      model:
        OPENROUTER_MODEL,

      apifyActor:
        APIFY_ACTOR,

      apifyBatchSize:
        APIFY_BATCH_SIZE,

      syncStrategy:
        'cursor-pagination',

      apifyMode:
        APIFY_MODE,

      time:
        nowIso()
    });
  }
);

/*
 * ========================================
 * ACCOUNTS
 * ========================================
 */

app.get(
  '/api/accounts',
  (req, res) => {
    res.json(
      db.accounts
    );
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
        return res
          .status(400)
          .json({
            error:
              'Instagram username is required.'
          });
      }

      const requestedStyle =
        String(
          req.body?.styleProfile ||
            'movie_tv'
        ).trim();

      const styleProfile =
        requestedStyle === 'music'
          ? 'music'
          : 'movie_tv';

      const existing =
        db.accounts.find(
          (account) =>
            account.username ===
            username
        );

      if (existing) {
        /*
         * Migration safety for accounts
         * created before V2.0.
         */
        if (
          !Object.prototype.hasOwnProperty.call(
            existing,
            'apifyPageId'
          )
        ) {
          existing.apifyPageId =
            null;
        }

        if (
          !Object.prototype.hasOwnProperty.call(
            existing,
            'apifyExhausted'
          )
        ) {
          existing.apifyExhausted =
            false;
        }

        if (
          !Object.prototype.hasOwnProperty.call(
            existing,
            'apifyLastRunId'
          )
        ) {
          existing.apifyLastRunId =
            null;
        }

        if (
          !Object.prototype.hasOwnProperty.call(
            existing,
            'apifyLastSyncAt'
          )
        ) {
          existing.apifyLastSyncAt =
            null;
        }

        if (
          !Object.prototype.hasOwnProperty.call(
            existing,
            'styleProfile'
          )
        ) {
          existing.styleProfile =
            styleProfile;
        }

        if (
          !Object.prototype.hasOwnProperty.call(
            existing,
            'styleRules'
          )
        ) {
          existing.styleRules = '';
        }

        if (
          !Object.prototype.hasOwnProperty.call(
            existing,
            'styleExamples'
          )
        ) {
          existing.styleExamples = [];
        }

        if (req.body?.styleRules !== undefined) {
          existing.styleRules = String(req.body.styleRules || '').trim().slice(0, 5000);
        }

        if (Array.isArray(req.body?.styleExamples)) {
          existing.styleExamples = req.body.styleExamples
            .map((item) => String(item || '').trim())
            .filter(Boolean)
            .slice(0, 10);
        }

        saveDb(db);

        return res.json(
          existing
        );
      }

      const account = {
        id:
          id('acc_'),

        username,

        createdAt:
          nowIso(),

        updatedAt:
          nowIso(),

        styleProfile,

        styleRules:
          String(req.body?.styleRules || '').trim().slice(0, 5000),

        styleExamples:
          Array.isArray(req.body?.styleExamples)
            ? req.body.styleExamples.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10)
            : [],

        apifyPageId:
          null,

        apifyExhausted:
          false,

        apifyLastRunId:
          null,

        apifyLastSyncAt:
          null
      };

      db.accounts.push(
        account
      );

      saveDb(db);

      res
        .status(201)
        .json(
          account
        );
    } catch (error) {
      console.error(
        'Create account error:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

app.post(
  '/api/accounts/:id/generate-style-dna',
  async (
    req,
    res
  ) => {
    try {
      const account = db.accounts.find(
        (item) => item.id === req.params.id
      );

      if (!account) {
        return res
          .status(404)
          .json({
            error: 'Instagram account not found.'
          });
      }

      if (!OPENROUTER_API_KEY) {
        return res
          .status(500)
          .json({
            error: 'OPENROUTER_API_KEY is not configured on Render.'
          });
      }

      const accountReels = db.reels
        .filter(
          (reel) =>
            reel.accountId === account.id
        )
        .sort(
          (a, b) => {
            const aDate = a.publishedAt
              ? new Date(a.publishedAt).getTime()
              : 0;
            const bDate = b.publishedAt
              ? new Date(b.publishedAt).getTime()
              : 0;
            return bDate - aDate;
          }
        );

      if (!accountReels.length) {
        return res
          .status(400)
          .json({
            error: 'No Reels have been synced for this account yet. Sync the Instagram account first.'
          });
      }

      /*
       * Prefer existing AI hooks when available because they represent
       * the actual on-screen hook style. Otherwise use the original
       * Instagram caption stored by Apify.
       */
      const examples = [];

      for (const reel of accountReels) {
        const hook =
          reel.analysis?.hook ||
          reel.selectedHook ||
          '';

        const caption =
          reel.caption ||
          '';

        const candidate =
          String(hook || caption)
            .replace(/\\s+/g, ' ')
            .trim();

        if (
          candidate &&
          !examples.includes(candidate)
        ) {
          examples.push(candidate.slice(0, 300));
        }

        if (examples.length >= 10) {
          break;
        }
      }

      if (!examples.length) {
        return res
          .status(400)
          .json({
            error: 'The synced Reels do not contain usable captions or analyzed hooks yet.'
          });
      }

      const sourceText = examples
        .map(
          (example, index) =>
            `${index + 1}. ${example}`
        )
        .join('\\n');

      const stylePrompt = `You are analyzing the established writing style of an Instagram account.

ACCOUNT STYLE:
${account.styleProfile === 'music'
  ? 'MUSIC'
  : 'MOVIE / TV'}

Below are real hooks or Instagram captions taken from this account. They are STYLE EVIDENCE, not facts to reuse.

REAL EXAMPLES:
${sourceText}

Create a concise Style DNA for this account.

Return ONLY valid JSON with exactly these fields:
{
  "styleRules": "5-10 concise rules describing the recurring writing style",
  "styleExamples": ["example 1", "example 2", "example 3", "example 4", "example 5"]
}

Rules:
- Base every rule only on patterns actually visible in the examples.
- Describe tone, sentence rhythm, wording, capitalization, punctuation, emoji use, curiosity, humor, attitude, length, and formatting when those patterns are present.
- Do not invent a style that is not supported by the examples.
- Do not copy or rewrite the examples into fake new examples.
- styleExamples MUST contain only exact examples from the supplied REAL EXAMPLES.
- Keep styleRules practical so another AI can follow them when creating new Reel hooks.
- Keep the final rules concise.`;

      const response =
        await requestJson(
          'https://openrouter.ai/api/v1/chat/completions',
          {
            method: 'POST',

            headers: {
              'Content-Type': 'application/json',

              Authorization:
                `Bearer ${OPENROUTER_API_KEY}`,

              'HTTP-Referer':
                'https://squin1983.github.io/Clipper/',

              'X-Title':
                'Clipper'
            },

            body:
              JSON.stringify({
                model:
                  OPENROUTER_MODEL,

                messages: [
                  {
                    role: 'user',

                    content:
                      stylePrompt
                  }
                ],

                response_format: {
                  type: 'json_object'
                }
              }),

            timeout:
              120000
          }
        );

      const rawContent =
        response
          ?.choices?.[0]
          ?.message
          ?.content;

      if (!rawContent) {
        throw new Error(
          'OpenRouter returned no Style DNA content.'
        );
      }

      let parsed =
        safeJsonParse(
          rawContent
        );

      if (!parsed) {
        const match =
          rawContent.match(
            /\\{[\\s\\S]*\\}/
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
          'OpenRouter returned invalid Style DNA JSON.'
        );
      }

      const styleRules =
        String(
          parsed.styleRules || ''
        )
          .trim()
          .slice(0, 5000);

      const returnedExamples =
        Array.isArray(
          parsed.styleExamples
        )
          ? parsed.styleExamples
              .map(
                (item) =>
                  String(item || '')
                    .trim()
              )
              .filter(Boolean)
          : [];

      const styleExamples =
        returnedExamples
          .filter(
            (example) =>
              examples.includes(
                example
              )
          )
          .slice(0, 10);

      account.styleRules =
        styleRules;

      account.styleExamples =
        styleExamples.length
          ? styleExamples
          : examples.slice(0, 10);

      account.updatedAt =
        nowIso();

      saveDb(db);

      res.json({
        ok: true,

        account,

        sourceReels:
          accountReels.length
      });
    } catch (error) {
      console.error(
        'Generate Style DNA error:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            'Style DNA generation failed.'
        });
    }
  }
);

app.put(
  '/api/accounts/:id',
  (req, res) => {
    try {
      const account = db.accounts.find(
        (item) => item.id === req.params.id
      );

      if (!account) {
        return res.status(404).json({ error: 'Instagram account not found.' });
      }

      if (req.body?.styleProfile !== undefined) {
        account.styleProfile =
          String(req.body.styleProfile).trim() === 'music'
            ? 'music'
            : 'movie_tv';
      }

      if (req.body?.styleRules !== undefined) {
        account.styleRules =
          String(req.body.styleRules || '').trim().slice(0, 5000);
      }

      if (Array.isArray(req.body?.styleExamples)) {
        account.styleExamples = req.body.styleExamples
          .map((item) => String(item || '').trim())
          .filter(Boolean)
          .slice(0, 10);
      }

      account.updatedAt = nowIso();
      saveDb(db);

      res.json(account);
    } catch (error) {
      console.error('Update account error:', error);
      res.status(500).json({ error: error.message });
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
        ok:
          true
      });
    } catch (error) {
      console.error(
        'Delete account error:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

/*
 * ========================================
 * CURSOR-BASED INSTAGRAM SYNC
 * ========================================
 */

app.post(
  '/api/accounts/:id/sync',
  async (
    req,
    res
  ) => {
    try {
      const account =
        db.accounts.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              'Instagram account not found.'
          });
      }

      /*
       * Migration safety for old accounts.
       */
      if (
        !Object.prototype.hasOwnProperty.call(
          account,
          'apifyPageId'
        )
      ) {
        account.apifyPageId =
          null;
      }

      if (
        !Object.prototype.hasOwnProperty.call(
          account,
          'apifyExhausted'
        )
      ) {
        account.apifyExhausted =
          false;
      }

      if (
        !Object.prototype.hasOwnProperty.call(
          account,
          'apifyLastRunId'
        )
      ) {
        account.apifyLastRunId =
          null;
      }

      if (
        !Object.prototype.hasOwnProperty.call(
          account,
          'apifyLastSyncAt'
        )
      ) {
        account.apifyLastSyncAt =
          null;
      }

      console.log(
        '=========================================='
      );

      console.log(
        `Starting V2.0.2 cursor sync for @${account.username}`
      );

      /*
       * If history is already exhausted,
       * don't waste another Apify run unless
       * force=true was explicitly requested.
       */
      if (
        account.apifyExhausted &&
        !req.body?.force
      ) {
        const existingReels =
          db.reels
            .filter(
              (reel) =>
                reel.accountId ===
                account.id
            )
            .sort(
              (a, b) =>
                new Date(
                  b.publishedAt ||
                    b.createdAt ||
                    0
                ) -
                new Date(
                  a.publishedAt ||
                    a.createdAt ||
                    0
                )
            );

        return res.json({
          ok:
            true,

          mode:
            'exhausted',

          account,

          added:
            0,

          updated:
            0,

          duplicates:
            0,

          raw:
            0,

          total:
            existingReels.length,

          oldestStored:
            existingReels.length
              ? existingReels[
                  existingReels.length -
                    1
                ].publishedAt
              : null,

          newestStored:
            existingReels.length
              ? existingReels[0]
                  .publishedAt
              : null,

          hasNextPage:
            false,

          exhausted:
            true,

          message:
            'Instagram history is already exhausted for this account.',

          reels:
            existingReels
        });
      }

      const pageId =
        account.apifyPageId ||
        null;

      console.log(
        pageId
          ? `Continuing from saved NEXT_PAGE_ID: ${String(
              pageId
            ).slice(
              0,
              40
            )}...`
          : 'No saved cursor. Starting from newest Reels.'
      );

      const apifyResult =
        await runApify(
          account.username,
          {
            maxPosts:
              APIFY_BATCH_SIZE,

            pageId
          }
        );

      const items =
        apifyResult.items ||
        [];

      console.log(
        `V2.0.2 received ${items.length} raw Apify items.`
      );

      const result =
        saveApifyItems(
          account,
          items
        );

      /*
       * IMPORTANT:
       * Save the new cursor only after the
       * dataset has been successfully processed.
       */
      account.apifyPageId =
        apifyResult.nextPageId ||
        null;

      account.apifyExhausted =
        !apifyResult.nextPageId;

      account.apifyLastRunId =
        apifyResult.runId ||
        null;

      account.apifyLastSyncAt =
        nowIso();

      account.updatedAt =
        nowIso();

      saveDb(db);

      const accountReels =
        db.reels
          .filter(
            (reel) =>
              reel.accountId ===
              account.id
          )
          .sort(
            (a, b) =>
              new Date(
                b.publishedAt ||
                  b.createdAt ||
                  0
              ) -
              new Date(
                a.publishedAt ||
                  a.createdAt ||
                  0
              )
          );

      const oldest =
        getOldestStoredReel(
          account.id
        );

      const newest =
        getNewestStoredReel(
          account.id
        );

      console.log(
        `V2.0.2 sync complete for @${account.username}: added=${result.added}, updated=${result.updated}, duplicates=${result.duplicates}, raw=${items.length}, total=${accountReels.length}, hasNext=${Boolean(
          account.apifyPageId
        )}`
      );

      res.json({
        ok:
          true,

        mode:
          pageId
            ? 'next-page'
            : 'initial',

        account,

        added:
          result.added,

        updated:
          result.updated,

        duplicates:
          result.duplicates,

        raw:
          items.length,

        total:
          accountReels.length,

        hasNextPage:
          Boolean(
            account.apifyPageId
          ),

        exhausted:
          account.apifyExhausted,

        nextPageSaved:
          Boolean(
            account.apifyPageId
          ),

        oldestStored:
          oldest?.publishedAt ||
          null,

        newestStored:
          newest?.publishedAt ||
          null,

        reels:
          accountReels
      });
    } catch (error) {
      console.error(
        'Instagram V2.0.2 sync error:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            'Instagram sync failed.'
        });
    }
  }
);

/*
 * ========================================
 * FORCE RESET PAGINATION
 * ========================================
 */

app.post(
  '/api/accounts/:id/reset-pagination',
  (req, res) => {
    try {
      const account =
        db.accounts.find(
          (item) =>
            item.id ===
            req.params.id
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              'Instagram account not found.'
          });
      }

      account.apifyPageId =
        null;

      account.apifyExhausted =
        false;

      account.apifyLastRunId =
        null;

      account.apifyLastSyncAt =
        null;

      account.updatedAt =
        nowIso();

      saveDb(db);

      res.json({
        ok:
          true,

        account
      });
    } catch (error) {
      console.error(
        'Reset pagination error:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message
        });
    }
  }
);

/*
 * ========================================
 * REELS
 * ========================================
 */

app.get(
  '/api/reels',
  (req, res) => {
    const requestedLimit =
      Number(
        req.query.limit ||
          1000
      );

    const limit =
      Math.min(
        Number.isFinite(
          requestedLimit
        )
          ? requestedLimit
          : 1000,
        5000
      );

    const reels =
      [...db.reels]
        .sort(
          (a, b) =>
            new Date(
              b.publishedAt ||
                b.createdAt ||
                0
            ) -
            new Date(
              a.publishedAt ||
                a.createdAt ||
                0
            )
        )
        .slice(
          0,
          limit
        );

    res.json(
      reels
    );
  }
);

app.post(
  '/api/reels/restore',
  (req, res) => {
    try {
      const reel = req.body?.reel;
      const account = req.body?.account;

      if (!reel?.id || !reel?.videoUrl) {
        return res.status(400).json({
          error: 'A Reel with id and videoUrl is required.'
        });
      }

      if (!account?.id || !account?.username) {
        return res.status(400).json({
          error: 'The Reel account is required.'
        });
      }

      let backendAccount = db.accounts.find(
        (item) => item.id === account.id
      );

      if (!backendAccount) {
        backendAccount = {
          ...account,
          createdAt: account.createdAt || nowIso(),
          updatedAt: nowIso()
        };
        db.accounts.push(backendAccount);
      }

      let existing = db.reels.find(
        (item) => item.id === reel.id
      );

      if (!existing && reel.shortcode) {
        existing = db.reels.find(
          (item) =>
            item.accountId === backendAccount.id &&
            item.shortcode === reel.shortcode
        );
      }

      const restored = {
        ...reel,
        id: reel.id,
        accountId: backendAccount.id,
        updatedAt: nowIso()
      };

      if (existing) {
        Object.assign(existing, restored);
      } else {
        db.reels.push(restored);
      }

      saveDb(db);

      res.json({
        ok: true,
        reel: existing || restored
      });
    } catch (error) {
      console.error('Restore Reel error:', error);
      res.status(500).json({
        error: error.message
      });
    }
  }
);

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
                b.createdAt ||
                0
            ) -
            new Date(
              a.publishedAt ||
                a.createdAt ||
                0
            )
        );

    res.json({
      reels
    });
  }
);

/*
 * ========================================
 * BATCHES
 * ========================================
 */

app.get(
  '/api/batches',
  (req, res) => {
    const batches =
      [...db.batches]
        .sort(
          (a, b) =>
            new Date(
              b.createdAt ||
                0
            ) -
            new Date(
              a.createdAt ||
                0
            )
        );

    res.json(
      batches
    );
  }
);

app.get(
  '/api/batch/random',
  (req, res) => {
    const accountId =
      req.query.accountId;

    const requestedLimit =
      Number(
        req.query.limit ||
          10
      );

    const limit =
      Math.min(
        Number.isFinite(
          requestedLimit
        )
          ? requestedLimit
          : 10,
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
          Math.random() -
          0.5
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

/*
 * ========================================
 * AI VIDEO ANALYSIS
 * ========================================
 */

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
      recursive:
        true
    }
  );

  let duration =
    null;

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
          timeout:
            30000
        }
      );

    const parsed =
      Number(
        String(
          result.stdout ||
            ''
        ).trim()
      );

    if (
      Number.isFinite(
        parsed
      ) &&
      parsed > 0
    ) {
      duration =
        parsed;
    }
  } catch (
    error
  ) {
    console.warn(
      'ffprobe duration failed:',
      error.message
    );
  }

  const framePaths =
    [];

  if (duration) {
    const percentages =
      [
        0.08,
        0.35,
        0.65,
        0.92
      ];

    for (
      let i = 0;
      i <
        percentages.length;
      i++
    ) {
      const timestamp =
        Math.max(
          0,
          Math.min(
            duration -
              0.1,
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
            String(
              timestamp
            ),

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
            timeout:
              30000
          }
        );

        if (
          fs.existsSync(
            output
          )
        ) {
          framePaths.push(
            output
          );
        }
      } catch (
        error
      ) {
        console.warn(
          `Frame ${
            i + 1
          } extraction failed:`,
          error.message
        );
      }
    }
  }

  if (
    framePaths.length <
    2
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
          timeout:
            30000
        }
      );

      if (
        fs.existsSync(
          fallback
        )
      ) {
        framePaths.push(
          fallback
        );
      }
    } catch (
      error
    ) {
      console.warn(
        'Fallback frame extraction failed:',
        error.message
      );
    }
  }

  return framePaths;
}

function imageToDataUrl(
  filePath
) {
  const buffer =
    fs.readFileSync(
      filePath
    );

  return (
    'data:image/jpeg;base64,' +
    buffer.toString(
      'base64'
    )
  );
}

async function analyzeVideoWithAI(
  videoPath,
  caption,
  styleProfile = 'movie_tv',
  styleRules = '',
  styleExamples = []
) {
  if (
    !OPENROUTER_API_KEY
  ) {
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

    if (
      !frames.length
    ) {
      throw new Error(
        'Could not extract frames from video.'
      );
    }

    const imageParts =
      frames.map(
        (
          framePath
        ) => ({
          type:
            'image_url',

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

ACCOUNT CONTENT STYLE:
${styleProfile === 'music' ? 'MUSIC — write hooks/captions in the established style of the Music Instagram account.' : 'MOVIE / TV — write hooks/captions in the established style of the Movie / TV Instagram account.'}
The selected account style is a hard requirement. Do not mix the two account styles.

STYLE DNA RULES:
${styleRules || 'No custom Style DNA rules have been added yet. Follow the selected account style only.'}

REAL EXAMPLES FROM THIS ACCOUNT:
${Array.isArray(styleExamples) && styleExamples.length ? styleExamples.map((example, index) => `${index + 1}. ${example}`).join('\n') : 'No examples have been added yet.'}
Use these examples as style references, not as facts to copy into the Reel. Match the rhythm, phrasing, attitude, and formatting patterns where appropriate, while keeping every generated hook factually tied to the actual Reel.

Return ONLY valid JSON.

The JSON must contain exactly these fields:

{
  "summary": "short factual summary of what happens",
  "hook": "the strongest short viral hook for the Reel",
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

Rules for hooks:
- English only.
- Every hook MUST be at least 5 words long. Prefer 6-9 words. NEVER use more than 10 words.
- The hook MUST clearly make sense based on the actual video content. It must describe or react to a specific person, action, moment, reaction, situation, joke, twist, or relationship that is genuinely visible or clearly stated in the Reel.
- Content relevance is more important than generic virality. Never invent context, motives, events, relationships, or details that are not visible or stated.
- Write like modern Gen-Z Instagram/Reels on-screen text: punchy, conversational, curious, slightly chaotic or reaction-driven when appropriate, but still natural and understandable.
- Prefer a concise, natural phrase or sentence with enough context to understand what the hook refers to.
- Keep it short enough for large bold on-screen text, normally 1-2 lines. Aim for about 55 characters when possible, but NEVER sacrifice meaning just to hit a character limit.
- Create curiosity from the actual content without falsely hiding or changing the context.
- Focus on the funniest, most surprising, awkward, iconic, controversial, or unexpected moment actually visible in the Reel.
- Use 1-2 relevant emojis when they genuinely fit the moment. Do not add random emojis or let emojis replace important words.
- Avoid unnecessary long names, explanations, dates, locations, and background details unless they are essential to understanding the actual moment.
- Avoid generic filler such as "This is crazy", "You won't believe this", or "Wait for it".
- Do not use quotation marks around hooks.
- Do not end hooks with a period.
- Each hook alternative must be meaningfully different AND independently relevant to the actual Reel, not the same sentence rearranged.
- The hook must make sense when read by itself and must be clearly connected to the Reel.
- The hook must be suitable for large bold on-screen text and should normally fit into 1-2 lines.

Rules for the other fields:
- Do not invent facts that are not visible or stated.
- Make on-screen text suitable for a Reel.
- Avoid generic filler.
- Focus on the actual moment shown.

Original Instagram caption:
${caption || ''}
`;

    const response =
      await requestJson(
        'https://openrouter.ai/api/v1/chat/completions',
        {
          method:
            'POST',

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

          body:
            JSON.stringify({
              model:
                OPENROUTER_MODEL,

              messages: [
                {
                  role:
                    'user',

                  content: [
                    {
                      type:
                        'text',

                      text:
                        prompt
                    },

                    ...imageParts
                  ]
                }
              ],

              response_format: {
                type:
                  'json_object'
              }
            }),

          timeout:
            120000
        }
      );

    const content =
      response
        ?.choices?.[0]
        ?.message
        ?.content;

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
          recursive:
            true,

          force:
            true
        }
      );
    } catch {}
  }
}

app.post(
  '/api/reels/:id/analyze',
  async (
    req,
    res
  ) => {
    const reel =
      db.reels.find(
        (item) =>
          item.id ===
          req.params.id
      );

    if (!reel) {
      return res
        .status(404)
        .json({
          error:
            'Reel not found.'
        });
    }

    if (
      !reel.videoUrl
    ) {
      return res
        .status(400)
        .json({
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

      const account =
        db.accounts.find(
          (item) =>
            item.id === reel.accountId
        );

      const styleProfile =
        account?.styleProfile === 'music'
          ? 'music'
          : 'movie_tv';

      const analysis =
        await analyzeVideoWithAI(
          videoPath,
          reel.caption,
          styleProfile,
          account?.styleRules || '',
          account?.styleExamples || []
        );

      reel.analysis =
        analysis;

      reel.updatedAt =
        nowIso();

      saveDb(db);

      res.json({
        ok:
          true,

        reel
      });
    } catch (
      error
    ) {
      console.error(
        'Analyze error:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            'Reel analysis failed.'
        });
    } finally {
      try {
        fs.rmSync(
          workDir,
          {
            recursive:
              true,

            force:
              true
          }
        );
      } catch {}
    }
  }
);

/*
 * ========================================
 * HOOK
 * ========================================
 */

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
      return res
        .status(404)
        .json({
          error:
            'Reel not found.'
        });
    }

    const hook =
      String(
        req.body?.hook ||
          ''
      ).trim();

    if (!hook) {
      return res
        .status(400)
        .json({
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
      ok:
        true,

      reel
    });
  }
);

/*
 * ========================================
 * RENDER
 * ========================================
 */

app.post(
  '/api/jobs/:reelId/render',
  async (
    req,
    res
  ) => {
    const reel =
      db.reels.find(
        (item) =>
          item.id ===
          req.params.reelId
      );

    if (!reel) {
      return res
        .status(404)
        .json({
          error:
            'Reel not found.'
        });
    }

    if (
      !reel.videoUrl
    ) {
      return res
        .status(400)
        .json({
          error:
            'Reel has no video URL.'
        });
    }

    const requestedHook =
      String(
        req.body?.hook ||
          ''
      ).trim();

    if (
      requestedHook
    ) {
      reel.selectedHook =
        requestedHook;

      reel.updatedAt =
        nowIso();

      saveDb(db);
    }

    const jobId =
      id('job_');

    const job = {
      id:
        jobId,

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

    db.jobs.push(
      job
    );

    saveDb(db);

    res.json({
      ok:
        true,

      job
    });

    (
      async () => {
        let workDir =
          null;

        try {
          job.status =
            'processing';

          job.updatedAt =
            nowIso();

          saveDb(db);

          workDir =
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

          /*
           * FFmpeg's drawtext font does not reliably support emoji,
           * so remove unsupported Unicode symbols to avoid square glyphs.
           */
          const safeHook =
            String(hook)
              .replace(/\s{2,}/g, ' ')
              .trim();

          const hookWords =
            safeHook
              .split(/\s+/)
              .filter(Boolean);

          /*
           * Keep the hook to a maximum of two visual lines.
           * We split around the middle instead of creating a tall
           * three/four-line block.
           */
          const hookLines = [];

          if (hookWords.length) {
            let bestSplit = hookWords.length;
            let bestDiff = Infinity;

            for (let split = 1; split < hookWords.length; split++) {
              const left = hookWords.slice(0, split).join(' ');
              const right = hookWords.slice(split).join(' ');
              const diff = Math.abs(left.length - right.length);

              if (
                left.length <= 30 &&
                right.length <= 30 &&
                diff < bestDiff
              ) {
                bestSplit = split;
                bestDiff = diff;
              }
            }

            if (bestSplit < hookWords.length) {
              hookLines.push(
                hookWords.slice(0, bestSplit).join(' ')
              );
              hookLines.push(
                hookWords.slice(bestSplit).join(' ')
              );
            } else {
              hookLines.push(
                hookWords.join(' ')
              );
            }
          }

          const hookTextPath =
            path.join(workDir, 'hook.txt');

          fs.writeFileSync(
            hookTextPath,
            hookLines.join('\n'),
            'utf8'
          );

          const escapedHookTextPath =
            hookTextPath
              .replace(/\\/g, '\\\\')
              .replace(/:/g, '\\:')
              .replace(/'/g, "\\'");

          const hookMaxLineLength =
            Math.max(
              ...hookLines.map(
                (line) => line.length
              ),
              0
            );

          const hookFontSize =
            hookMaxLineLength > 26
              ? 46
              : 56;

          /*
           * Instagram Reel source is normally horizontal.
           * Fit it inside the 9:16 canvas instead of cropping the sides.
           *
           * The original source hook sits near the top of the horizontal
           * video. Cover only that area with an opaque black strip so the
           * original hook cannot bleed through.
           */
          const filter =
            [
              'scale=1080:1920:force_original_aspect_ratio=decrease',
              'pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black',
              'setsar=1',
              hookLines.length
                ? 'drawbox=x=0:y=650:w=iw:h=300:color=black@1.0:t=fill'
                : null,
              hookLines.length
                ? `drawtext=font='DejaVu Sans:style=Bold':textfile='${escapedHookTextPath}':fontcolor=white:alpha=1:fontsize=${hookFontSize}:line_spacing=8:borderw=5:bordercolor=black:x=(w-text_w)/2:y=700`
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

              '-threads',
              '2',

              '-c:v',
              'libx264',

              '-preset',
              'ultrafast',

              '-crf',
              '25',

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
        } catch (
          error
        ) {
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

          if (
            currentJob
          ) {
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
        } finally {
          if (
            workDir
          ) {
            try {
              fs.rmSync(
                workDir,
                {
                  recursive:
                    true,

                  force:
                    true
                }
              );
            } catch {}
          }
        }
      }
    )();
  }
);

/*
 * ========================================
 * JOBS
 * ========================================
 */

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
      return res
        .status(404)
        .json({
          error:
            'Job not found.'
        });
    }

    res.json({
      job
    });
  }
);

function sendRenderedFile(
  req,
  res
) {
  const job =
    db.jobs.find(
      (item) =>
        item.id ===
        req.params.id
    );

  if (!job) {
    return res
      .status(404)
      .send(
        'Render job not found.'
      );
  }

  if (
    job.status !==
    'completed'
  ) {
    return res
      .status(409)
      .send(
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
    return res
      .status(404)
      .send(
        'Rendered file no longer exists.'
      );
  }

  res.download(
    filePath,
    `clipper-${job.reelId}.mp4`
  );
}

app.get(
  '/api/jobs/:id/download',
  sendRenderedFile
);

app.get(
  '/api/jobs/:id/file',
  sendRenderedFile
);

/*
 * ========================================
 * 404
 * ========================================
 */

app.use(
  (req, res) => {
    res
      .status(404)
      .json({
        error:
          'Endpoint not found.',

        path:
          req.path
      });
  }
);

/*
 * ========================================
 * ERROR HANDLER
 * ========================================
 */

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
      return next(
        error
      );
    }

    res
      .status(500)
      .json({
        error:
          error.message ||
          'Internal server error.'
      });
  }
);

/*
 * ========================================
 * START
 * ========================================
 */

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
      `Apify batch size: ${APIFY_BATCH_SIZE}`
    );

    console.log(
      `Apify mode: ${APIFY_MODE}`
    );

    console.log(
      'Sync strategy: cursor-pagination'
    );

    console.log(
      `OpenRouter model: ${OPENROUTER_MODEL}`
    );
  }
);