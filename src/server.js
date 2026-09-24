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

const VERSION = '2.0.2';

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
  return firstNonEmpty(
    item.videoUrl,

    item.video_url,

    item.video,

    item.mediaUrl,

    item.downloadUrl,

    item.urlVideo
  );
}

function getThumbnail(item) {
  return firstNonEmpty(
    item.thumbnailUrl,

    item.thumbnail,

    item.displayUrl,

    item.imageUrl,

    item.image
  );
}

function getCaption(item) {
  return firstNonEmpty(
    item.caption,

    item.text,

    item.description,

    ''
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

      item.owner?.username,

      fallback
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

    item.externalId,

    getShortcode(item),

    getReelUrl(item)
  );
}

function getTimestamp(item) {
  return parseDate(
    firstNonEmpty(
      item.takenAt,

      item.timestamp,

      item.publishedAt,

      item.createdAt,

      item.taken_at,

      item.takenAtTimestamp
        ? Number(
            item.takenAtTimestamp
          ) * 1000
        : null
    )
  );
}

function getOldestStoredReel(
  accountId
) {
  return db.reels
    .filter(
      (reel) =>
        reel.accountId ===
        accountId
    )
    .sort(
      (a, b) =>
        new Date(
          a.publishedAt ||
            a.createdAt ||
            0
        ) -
        new Date(
          b.publishedAt ||
            b.createdAt ||
            0
        )
    )[0] || null;
}

function getNewestStoredReel(
  accountId
) {
  return db.reels
    .filter(
      (reel) =>
        reel.accountId ===
        accountId
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
    )[0] || null;
}

/*
 * ========================================
 * APIFY CURSOR
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

/*
 * ========================================
 * APIFY RUN
 * ========================================
 */

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
 * SYNC
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
              'Account not found.'
          });
      }

      /*
       * Migration safety for accounts
       * created before cursor pagination.
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

      /*
       * If Apify already told us that there
       * are no more pages, do not repeatedly
       * start the actor.
       */
      if (
        account.apifyExhausted
      ) {
        return res.json({
          ok:
            true,

          message:
            'No more historical Reels are available for this account.',

          added:
            0,

          updated:
            0,

          duplicates:
            0,

          raw:
            0,

          total:
            db.reels.filter(
              (reel) =>
                reel.accountId ===
                account.id
            ).length,

          oldestStored:
            getOldestReelDate(
              account.id
            ),

          newestStored:
            getNewestReelDate(
              account.id
            ),

          hasNextPage:
            false,

          nextPageId:
            null,

          exhausted:
            true,

          runId:
            account.apifyLastRunId ||
            null,

          datasetId:
            null,

          keyValueStoreId:
            null,

          reels:
            db.reels.filter(
              (reel) =>
                reel.accountId ===
                account.id
            )
        });
      }

      const pageId =
        account.apifyPageId ||
        null;

      console.log(
        `Starting sync for @${account.username}` +
          (
            pageId
              ? ` with pageId ${String(
                  pageId
                ).slice(
                  0,
                  40
                )}...`
              : ' from first page'
          )
      );

      const result =
        await runApify(
          account.username,
          pageId
        );

      console.log(
        `V2.0.2 received ${result.items.length} raw Apify items.`
      );

      const saveResult =
        saveApifyItems(
          account,
          result.items
        );

      /*
       * Save the cursor returned by Apify.
       *
       * If no cursor is returned, we have
       * reached the end of the available
       * historical pages.
       */
      account.apifyPageId =
        result.nextPageId ||
        null;

      account.apifyExhausted =
        !result.nextPageId;

      account.apifyLastRunId =
        result.runId ||
        null;

      account.apifyLastSyncAt =
        nowIso();

      account.updatedAt =
        nowIso();

      saveDb(db);

      const accountReels =
        db.reels.filter(
          (reel) =>
            reel.accountId ===
            account.id
        );

      console.log(
        `V2.0.2 sync complete for @${account.username}:` +
          ` added=${saveResult.added},` +
          ` updated=${saveResult.updated},` +
          ` duplicates=${saveResult.duplicates},` +
          ` raw=${result.items.length},` +
          ` total=${accountReels.length},` +
          ` hasNext=${Boolean(
            result.nextPageId
          )}`
      );

      res.json({
        ok:
          true,

        added:
          saveResult.added,

        updated:
          saveResult.updated,

        duplicates:
          saveResult.duplicates,

        raw:
          result.items.length,

        total:
          accountReels.length,

        oldestStored:
          getOldestReelDate(
            account.id
          ),

        newestStored:
          getNewestReelDate(
            account.id
          ),

        hasNextPage:
          Boolean(
            result.nextPageId
          ),

        nextPageId:
          result.nextPageId ||
          null,

        exhausted:
          account.apifyExhausted,

        runId:
          result.runId,

        datasetId:
          result.datasetId,

        keyValueStoreId:
          result.keyValueStoreId,

        reels:
          accountReels
      });
    } catch (error) {
      console.error(
        'Sync error:',
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
    const accountId =
      req.query?.accountId;

    let reels =
      db.reels;

    if (accountId) {
      reels =
        reels.filter(
          (reel) =>
            reel.accountId ===
            accountId
        );
    }

    res.json(
      reels
    );
  }
);

app.get(
  '/api/reels/random',
  (req, res) => {
    const limit =
      Math.max(
        1,
        Math.min(
          50,
          Number(
            req.query?.limit
          ) ||
            10
        )
      );

    const accountId =
      req.query?.accountId;

    let reels =
      db.reels;

    if (accountId) {
      reels =
        reels.filter(
          (reel) =>
            reel.accountId ===
            accountId
        );
    }

    /*
     * Prefer reels that have not yet
     * been used in a batch.
     */
    const unused =
      reels.filter(
        (reel) =>
          !reel.used
      );

    const source =
      unused.length >=
      limit
        ? unused
        : reels;

    const shuffled =
      [...source].sort(
        () =>
          Math.random() -
          0.5
      );

    res.json(
      shuffled.slice(
        0,
        limit
      )
    );
  }
);

app.get(
  '/api/reels/:id',
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

    res.json(
      reel
    );
  }
);

/*
 * ========================================
 * AI ANALYSIS
 * ========================================
 */

app.post(
  '/api/reels/:id/analyze',
  async (
    req,
    res
  ) => {
    try {
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

      const prompt = `
Analyze this Instagram Reel for short-form viral potential.

Username:
@${reel.username}

Caption:
${reel.caption || ''}

URL:
${reel.url || ''}

Return JSON with:
{
  "hook": "short hook",
  "score": 1-100,
  "why": "brief explanation",
  "ideas": [
    "idea 1",
    "idea 2",
    "idea 3"
  ]
}

Do not use markdown.
Return valid JSON only.
`;

      const raw =
        await callOpenRouter(
          prompt
        );

      /*
       * DEBUG:
       * Log the exact OpenRouter response
       * so we can see what the free model
       * actually returned.
       */
      console.log(
        'OPENROUTER RAW RESPONSE:',
        JSON.stringify(
          raw,
          null,
          2
        )
      );

      let analysis;

      try {
        analysis =
          JSON.parse(
            raw
          );
      } catch (
        parseError
      ) {
        /*
         * Some free models may still wrap
         * JSON in markdown despite the prompt.
         * Remove common markdown fences and
         * try once more.
         */
        const cleaned =
          String(
            raw
          )
            .replace(
              /^```json\s*/i,
              ''
            )
            .replace(
              /^```\s*/i,
              ''
            )
            .replace(
              /\s*```$/i,
              ''
            )
            .trim();

        try {
          analysis =
            JSON.parse(
              cleaned
            );
        } catch (
          secondParseError
        ) {
          console.error(
            'AI JSON parse error:',
            parseError
          );

          console.error(
            'AI cleaned response:',
            cleaned
          );

          return res
            .status(502)
            .json({
              error:
                'AI returned invalid JSON.',

              raw:
                raw
            });
        }
      }

      /*
       * Normalize the fields so the
       * frontend always receives the
       * expected structure.
       */
      const normalizedAnalysis = {
        hook:
          String(
            analysis?.hook ||
              ''
          ).trim(),

        score:
          Math.max(
            1,
            Math.min(
              100,
              Number(
                analysis?.score
              ) ||
                0
            )
          ),

        why:
          String(
            analysis?.why ||
              ''
          ).trim(),

        ideas:
          Array.isArray(
            analysis?.ideas
          )
            ? analysis.ideas
                .map(
                  (item) =>
                    String(
                      item
                    ).trim()
                )
                .filter(
                  Boolean
                )
            : []
      };

      /*
       * Save analysis to the reel.
       */
      reel.analysis =
        normalizedAnalysis;

      reel.updatedAt =
        nowIso();

      saveDb(
        db
      );

      res.json({
        ok:
          true,

        analysis:
          normalizedAnalysis,

        reel
      });
    } catch (error) {
      console.error(
        'AI analysis error:',
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
 * SELECT HOOK
 * ========================================
 */

app.post(
  '/api/reels/:id/hook',
  (req, res) => {
    try {
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

      saveDb(
        db
      );

      res.json({
        ok:
          true,

        selectedHook:
          reel.selectedHook,

        reel
      });
    } catch (error) {
      console.error(
        'Select hook error:',
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
 * BATCHES
 * ========================================
 */

app.get(
  '/api/batches',
  (req, res) => {
    res.json(
      db.batches
    );
  }
);

app.post(
  '/api/batches',
  (req, res) => {
    try {
      const accountId =
        req.body?.accountId ||
        null;

      const reelIds =
        Array.isArray(
          req.body?.reelIds
        )
          ? req.body.reelIds
          : [];

      const uniqueReelIds =
        [
          ...new Set(
            reelIds.map(
              (item) =>
                String(
                  item
                )
            )
          )
        ];

      if (
        uniqueReelIds.length ===
        0
      ) {
        return res
          .status(400)
          .json({
            error:
              'At least one reel is required.'
          });
      }

      const reels =
        uniqueReelIds
          .map(
            (reelId) =>
              db.reels.find(
                (reel) =>
                  reel.id ===
                  reelId
              )
          )
          .filter(
            Boolean
          );

      if (
        reels.length ===
        0
      ) {
        return res
          .status(404)
          .json({
            error:
              'No valid reels found.'
          });
      }

      const batch = {
        id:
          id('batch_'),

        accountId,

        reelIds:
          reels.map(
            (reel) =>
              reel.id
          ),

        createdAt:
          nowIso(),

        status:
          'ready'
      };

      db.batches.push(
        batch
      );

      /*
       * Mark reels as used so RANDOM 10
       * can prefer fresh material next time.
       */
      for (
        const reel of reels
      ) {
        reel.used =
          true;

        reel.updatedAt =
          nowIso();
      }

      saveDb(
        db
      );

      res
        .status(201)
        .json({
          batch,

          reels
        });
    } catch (error) {
      console.error(
        'Create batch error:',
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
    const response =
      await callOpenRouterVision(
        prompt,
        imageParts
      );

    console.log(
      'OPENROUTER VIDEO RAW RESPONSE:',
      JSON.stringify(
        response,
        null,
        2
      )
    );

    let parsed;

    try {
      parsed =
        JSON.parse(
          response
        );
    } catch (
      parseError
    ) {
      const cleaned =
        String(
          response
        )
          .replace(
            /^```json\s*/i,
            ''
          )
          .replace(
            /^```\s*/i,
            ''
          )
          .replace(
            /\s*```$/i,
            ''
          )
          .trim();

      try {
        parsed =
          JSON.parse(
            cleaned
          );
      } catch (
        secondParseError
      ) {
        console.error(
          'Video AI JSON parse error:',
          parseError
        );

        console.error(
          'Video AI cleaned response:',
          cleaned
        );

        throw new Error(
          'AI returned invalid JSON for video analysis.'
        );
      }
    }

    return {
      summary:
        String(
          parsed?.summary ||
            ''
        ).trim(),

      hook:
        String(
          parsed?.hook ||
            ''
        ).trim(),

      hookAlternatives:
        Array.isArray(
          parsed?.hookAlternatives
        )
          ? parsed.hookAlternatives
              .map(
                (item) =>
                  String(
                    item
                  ).trim()
              )
              .filter(
                Boolean
              )
          : [],

      onScreenText:
        String(
          parsed?.onScreenText ||
            ''
        ).trim(),

      caption:
        String(
          parsed?.caption ||
            ''
        ).trim(),

      hashtags:
        Array.isArray(
          parsed?.hashtags
        )
          ? parsed.hashtags
              .map(
                (item) =>
                  String(
                    item
                  ).trim()
              )
              .filter(
                Boolean
              )
          : [],

      tone:
        String(
          parsed?.tone ||
            ''
        ).trim(),

      topics:
        Array.isArray(
          parsed?.topics
        )
          ? parsed.topics
              .map(
                (item) =>
                  String(
                    item
                  ).trim()
              )
              .filter(
                Boolean
              )
          : []
    };
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
    } catch (
      error
    ) {
      console.warn(
        'Could not remove AI work directory:',
        error.message
      );
    }
  }
}

/*
 * ========================================
 * DOWNLOAD SOURCE VIDEO
 * ========================================
 */

async function downloadVideo(
  url,
  outputPath
) {
  if (!url) {
    throw new Error(
      'Video URL is missing.'
    );
  }

  console.log(
    `Downloading video: ${url}`
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36',

          Accept:
            'video/mp4,video/*;q=0.9,*/*;q=0.8'
        },

        redirect:
          'follow',

        timeout:
          120000
      }
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `Video download failed with HTTP ${response.status}.`
    );
  }

  const contentType =
    response.headers.get(
      'content-type'
    ) ||
    '';

  if (
    !contentType.includes(
      'video'
    ) &&
    !contentType.includes(
      'octet-stream'
    )
  ) {
    console.warn(
      `Unexpected video content-type: ${contentType}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  if (
    !buffer.length
  ) {
    throw new Error(
      'Downloaded video is empty.'
    );
  }

  fs.writeFileSync(
    outputPath,
    buffer
  );

  console.log(
    `Video downloaded: ${buffer.length} bytes`
  );

  return outputPath;
}

/*
 * ========================================
 * VIDEO ANALYSIS ENDPOINT
 * ========================================
 */

app.post(
  '/api/reels/:id/analyze-video',
  async (
    req,
    res
  ) => {
    try {
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
              'This Reel does not have a video URL.'
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
        await downloadVideo(
          reel.videoUrl,
          videoPath
        );

        const analysis =
          await analyzeVideoWithAI(
            videoPath,
            reel.caption
          );

        reel.videoAnalysis =
          analysis;

        reel.updatedAt =
          nowIso();

        saveDb(
          db
        );

        res.json({
          ok:
            true,

          analysis,

          reel
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
        } catch (
          error
        ) {
          console.warn(
            'Could not remove video work directory:',
            error.message
          );
        }
      }
    } catch (error) {
      console.error(
        'Video analysis error:',
        error
      );

      res
        .status(500)
        .json({
          error:
            error.message ||
            'Video analysis failed.'
        });
    }
  }
);

/*
 * ========================================
 * RENDER
 * ========================================
 */

function escapeDrawtext(
  value
) {
  return String(
    value ||
      ''
  )
    .replace(
      /\\/g,
      '\\\\'
    )
    .replace(
      /:/g,
      '\\:'
    )
    .replace(
      /'/g,
      "\\'"
    )
    .replace(
      /%/g,
      '\\%'
    );
}

async function renderReel(
  reel,
  options
) {
  if (
    !reel.videoUrl
  ) {
    throw new Error(
      'This Reel does not have a video URL.'
    );
  }

  const hook =
    String(
      options?.hook ||
        reel.selectedHook ||
        reel.analysis?.hook ||
        ''
    ).trim();

  if (!hook) {
    throw new Error(
      'No hook selected for rendering.'
    );
  }

  const jobId =
    id('job_');

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
      workDir,
      `${jobId}.mp4`
    );

  try {
    await downloadVideo(
      reel.videoUrl,
      sourcePath
    );

    const position =
      options?.position ||
      'center';

    let yExpression =
      '(h-text_h)/2';

    if (
      position ===
      'top'
    ) {
      yExpression =
        'h*0.12';
    }

    if (
      position ===
      'bottom'
    ) {
      yExpression =
        'h*0.78';
    }

    const font =
      options?.font ||
      'bold';

    let fontFile =
      '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

    if (
      font ===
      'clean'
    ) {
      fontFile =
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
    }

    const escapedHook =
      escapeDrawtext(
        hook
      );

    const filter =
      `drawtext=fontfile=${fontFile}:text='${escapedHook}':fontcolor=white:fontsize=52:borderw=4:bordercolor=black:x=(w-text_w)/2:y=${yExpression}`;

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
          180000
      }
    );

    if (
      !fs.existsSync(
        outputPath
      )
    ) {
      throw new Error(
        'FFmpeg did not create the rendered video.'
      );
    }

    const stats =
      fs.statSync(
        outputPath
      );

    if (
      stats.size ===
      0
    ) {
      throw new Error(
        'Rendered video is empty.'
      );
    }

    return {
      jobId,

      outputPath,

      size:
        stats.size,

      hook,

      position,

      font
    };
  } catch (
    error
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
    } catch (
      cleanupError
    ) {
      console.warn(
        'Render cleanup failed:',
        cleanupError.message
      );
    }

    throw error;
  }
}

/*
 * ========================================
 * RENDER ENDPOINT
 * ========================================
 */

app.post(
  '/api/reels/:id/render',
  async (
    req,
    res
  ) => {
    try {
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
            reel.selectedHook ||
            reel.analysis?.hook ||
            ''
        ).trim();

      if (!hook) {
        return res
          .status(400)
          .json({
            error:
              'Please select a hook before rendering.'
          });
      }

      const job = {
        id:
          id('job_'),

        reelId:
          reel.id,

        status:
          'processing',

        hook,

        position:
          req.body?.position ||
          'center',

        font:
          req.body?.font ||
          'bold',

        createdAt:
          nowIso(),

        updatedAt:
          nowIso(),

        filePath:
          null,

        fileSize:
          0,

        error:
          null
      };

      db.jobs.push(
        job
      );

      reel.selectedHook =
        hook;

      reel.updatedAt =
        nowIso();

      saveDb(
        db
      );

      /*
       * Return immediately so the frontend
       * can poll /api/jobs/:id.
       */
      res
        .status(202)
        .json({
          ok:
            true,

          job
        });

      try {
        const result =
          await renderReel(
            reel,
            {
              hook:
                job.hook,

              position:
                job.position,

              font:
                job.font
            }
          );

        /*
         * Move the rendered file to a
         * persistent temporary location.
         */
        const finalDir =
          path.join(
            '/tmp',
            'clipper-renders'
          );

        fs.mkdirSync(
          finalDir,
          {
            recursive:
              true
          }
        );

        const finalPath =
          path.join(
            finalDir,
            `${job.id}.mp4`
          );

        fs.copyFileSync(
          result.outputPath,
          finalPath
        );

        job.status =
          'completed';

        job.filePath =
          finalPath;

        job.fileSize =
          fs.statSync(
            finalPath
          ).size;

        job.updatedAt =
          nowIso();

        job.downloadUrl =
          `/api/jobs/${job.id}/download`;

        job.fileUrl =
          `/api/jobs/${job.id}/file`;

        saveDb(
          db
        );

        /*
         * Clean up the render working
         * directory created inside renderReel.
         */
        try {
          fs.rmSync(
            path.dirname(
              result.outputPath
            ),
            {
              recursive:
                true,

              force:
                true
            }
          );
        } catch (
          cleanupError
        ) {
          console.warn(
            'Render output cleanup failed:',
            cleanupError.message
          );
        }

        console.log(
          `Render completed: ${job.id}`
        );
      } catch (
        renderError
      ) {
        console.error(
          `Render failed for ${job.id}:`,
          renderError
        );

        job.status =
          'failed';

        job.error =
          renderError.message ||
          'Render failed.';

        job.updatedAt =
          nowIso();

        saveDb(
          db
        );
      }
    } catch (error) {
      console.error(
        'Render endpoint error:',
        error
      );

      if (
        !res.headersSent
      ) {
        res
          .status(500)
          .json({
            error:
              error.message
          });
      }
    }
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
              )
              .replace(
                /%/g,
                '\\%'
              );

          const filter =
            [
              'scale=1080:1920:force_original_aspect_ratio=increase',

              'crop=1080:1920',

              'setsar=1',

              escapedHook
                ? `drawtext=text='${escapedHook}':fontcolor=white:fontsize=58:borderw=4:bordercolor=black:x=(w-text_w)/2:y=140:box=1:boxcolor=black@0.35:boxborderw=20`
                : null
            ]
              .filter(
                Boolean
              )
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
