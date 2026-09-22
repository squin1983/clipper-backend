const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const { execFile } = require("child_process");
const { promisify } = require("util");

dotenv.config();

const execFileAsync = promisify(execFile);

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 10000;
const APIFY_TOKEN = process.env.APIFY_TOKEN || "";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";

const DB_FILE = path.join("/tmp", "clipper-db.json");
const ACTOR_ID = "instagram-scraper~instagram-profile-reels-scraper";

const RENDER_FONT =
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";

function ensureDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(
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

function readDb() {
  ensureDb();

  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch (error) {
    return {
      accounts: [],
      reels: [],
      batches: [],
      jobs: []
    };
  }
}

function writeDb(db) {
  ensureDb();

  fs.writeFileSync(
    DB_FILE,
    JSON.stringify(db, null, 2)
  );
}

function id(prefix = "id") {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

function now() {
  return new Date().toISOString();
}

function cleanUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@/, "")
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, "")
    .split(/[/?#]/)[0]
    .trim();
}

function pickValue(item, keys) {
  for (const key of keys) {
    if (
      item &&
      item[key] !== undefined &&
      item[key] !== null &&
      item[key] !== ""
    ) {
      return item[key];
    }
  }

  return "";
}

function pickPermalink(item) {
  return pickValue(item, [
    "permalink",
    "url",
    "postUrl",
    "webUrl",
    "displayUrl"
  ]);
}

function pickVideoUrl(item) {
  return pickValue(item, [
    "videoUrl",
    "video",
    "video_url",
    "downloadUrl",
    "download_url"
  ]);
}

function pickThumbnail(item) {
  return pickValue(item, [
    "thumbnailUrl",
    "thumbnail",
    "displayUrl",
    "imageUrl",
    "image"
  ]);
}

function pickCaption(item) {
  return pickValue(item, [
    "caption",
    "text",
    "description"
  ]);
}

function pickDate(item) {
  return pickValue(item, [
    "timestamp",
    "takenAt",
    "taken_at",
    "date"
  ]);
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();

  let data;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {
      raw: text
    };
  }

  if (!response.ok) {
    const error = new Error(
      `HTTP ${response.status}: ${text}`
    );

    error.status = response.status;
    error.data = data;

    throw error;
  }

  return data;
}

async function downloadFile(url, outputPath) {
  const client = url.startsWith("https://")
    ? https
    : http;

  return new Promise((resolve, reject) => {
    const request = client.get(
      url,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151 Safari/537.36"
        }
      },
      response => {
        if (
          response.statusCode >= 300 &&
          response.statusCode < 400 &&
          response.headers.location
        ) {
          response.resume();

          downloadFile(
            response.headers.location,
            outputPath
          )
            .then(resolve)
            .catch(reject);

          return;
        }

        if (response.statusCode !== 200) {
          response.resume();

          reject(
            new Error(
              `Video download failed: HTTP ${response.statusCode}`
            )
          );

          return;
        }

        const file = fs.createWriteStream(
          outputPath
        );

        response.pipe(file);

        file.on("finish", () => {
          file.close(resolve);
        });

        file.on("error", reject);
      }
    );

    request.on("error", reject);
  });
}

async function extractFrames(videoPath, outputDir) {
  fs.mkdirSync(outputDir, {
    recursive: true
  });

  const outputPattern = path.join(
    outputDir,
    "frame-%02d.jpg"
  );

  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      "fps=1/3,scale=640:-1",
      "-frames:v",
      "6",
      outputPattern
    ],
    {
      maxBuffer: 10 * 1024 * 1024
    }
  );

  const files = fs
    .readdirSync(outputDir)
    .filter(file => /^frame-\d+\.jpg$/i.test(file))
    .sort();

  return files.map(file =>
    path.join(outputDir, file)
  );
}

function imageToDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);

  return `data:image/jpeg;base64,${buffer.toString(
    "base64"
  )}`;
}

async function analyzeWithOpenRouter(
  framePaths,
  reel
) {
  if (!OPENROUTER_API_KEY) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured on Render."
    );
  }

  const images = framePaths.map(
    imageToDataUrl
  );

  const content = [
    {
      type: "text",
      text: `
You are analyzing an Instagram Reel for a content creator.

IMPORTANT:
- Analyze ONLY what is actually visible in the supplied frames.
- Do NOT invent dialogue, events, people, relationships, locations or context that cannot be established from the frames.
- If something is uncertain, say that it is uncertain.
- Identify the central subject or moment.
- Create hooks that are specific to this actual Reel.
- Do not use generic hooks such as "You won't believe this", "Wait until you see this", etc.
- Hooks must be short.
- Maximum 12 words per hook.
- Create exactly 5 different hook options.
- Create one concise Instagram caption based only on what can reasonably be established.
- Do not copy wording from the original caption.
- The hooks should be suitable as on-screen text.

Return ONLY valid JSON in this format:

{
  "summary": "short factual description",
  "hooks": [
    "hook 1",
    "hook 2",
    "hook 3",
    "hook 4",
    "hook 5"
  ],
  "caption": "short caption"
}

Original Reel caption, which may be incomplete or misleading:
${String(reel.caption || "").slice(0, 3000)}
`
    }
  ];

  for (const image of images) {
    content.push({
      type: "image_url",
      image_url: {
        url: image
      }
    });
  }

  const body = {
    model: "openrouter/free",
    messages: [
      {
        role: "user",
        content
      }
    ],
    temperature: 0.7,
    max_tokens: 900
  };

  const response = await fetchJson(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer":
          "https://squin1983.github.io/Clipper/",
        "X-Title": "Clipper"
      },
      body: JSON.stringify(body)
    }
  );

  const text =
    response?.choices?.[0]?.message?.content || "";

  if (!text) {
    throw new Error(
      "OpenRouter returned an empty response."
    );
  }

  let cleaned = text.trim();

  if (cleaned.startsWith("```")) {
    cleaned = cleaned
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  let parsed;

  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(
      /\{[\s\S]*\}/
    );

    if (!match) {
      throw new Error(
        `AI returned invalid JSON: ${cleaned.slice(
          0,
          1000
        )}`
      );
    }

    parsed = JSON.parse(match[0]);
  }

  const hooks = Array.isArray(parsed.hooks)
    ? parsed.hooks
        .map(x => String(x).trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];

  while (hooks.length < 5) {
    hooks.push("");
  }

  return {
    summary: String(
      parsed.summary || ""
    ).trim(),

    hooks,

    caption: String(
      parsed.caption || ""
    ).trim()
  };
}

async function startApifyRun(username) {
  if (!APIFY_TOKEN) {
    throw new Error(
      "APIFY_TOKEN is not configured on Render."
    );
  }

  const clean = cleanUsername(username);

  if (!clean) {
    throw new Error(
      "Instagram username is missing."
    );
  }

  /*
   * IMPORTANT:
   * The current Apify actor requires:
   * input.instagramUsernames
   */
  const input = {
    instagramUsernames: [clean],
    resultsLimit: 30
  };

  const url =
    `https://api.apify.com/v2/acts/${encodeURIComponent(
      ACTOR_ID
    )}/runs?token=${encodeURIComponent(
      APIFY_TOKEN
    )}`;

  const data = await fetchJson(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(input)
  });

  if (!data?.data?.id) {
    throw new Error(
      `Apify did not return a run ID: ${JSON.stringify(
        data
      )}`
    );
  }

  return data.data;
}

async function waitForApifyRun(runId) {
  const maxAttempts = 60;

  for (
    let attempt = 0;
    attempt < maxAttempts;
    attempt++
  ) {
    const url =
      `https://api.apify.com/v2/actor-runs/${encodeURIComponent(
        runId
      )}?token=${encodeURIComponent(
        APIFY_TOKEN
      )}`;

    const data = await fetchJson(url);

    const status = data?.data?.status;

    if (
      [
        "SUCCEEDED",
        "FAILED",
        "ABORTED",
        "TIMED-OUT"
      ].includes(status)
    ) {
      return data.data;
    }

    await new Promise(resolve =>
      setTimeout(resolve, 2000)
    );
  }

  throw new Error(
    "Apify run timed out while waiting for completion."
  );
}

async function getApifyDatasetItems(datasetId) {
  const url =
    `https://api.apify.com/v2/datasets/${encodeURIComponent(
      datasetId
    )}/items?token=${encodeURIComponent(
      APIFY_TOKEN
    )}&clean=true&format=json`;

  const data = await fetchJson(url);

  return Array.isArray(data) ? data : [];
}

function normalizeReel(item, account) {
  const reelId =
    String(
      pickValue(item, [
        "id",
        "shortCode",
        "shortcode",
        "code"
      ])
    ) || id("reel");

  return {
    id: reelId,
    accountId: account.id,

    shortcode: String(
      pickValue(item, [
        "shortCode",
        "shortcode",
        "code"
      ]) || ""
    ),

    username:
      cleanUsername(
        pickValue(item, [
          "username",
          "ownerUsername",
          "owner"
        ])
      ) ||
      cleanUsername(account.username),

    caption: pickCaption(item),

    permalink: pickPermalink(item),

    videoUrl: pickVideoUrl(item),

    previewUrl: pickThumbnail(item),

    timestamp: pickDate(item),

    fetchedAt: now(),

    used: false,

    aiAnalysis: null,

    selectedHook: ""
  };
}

function mergeReel(db, incoming) {
  const index = db.reels.findIndex(
    reel =>
      reel.id === incoming.id ||
      (
        incoming.shortcode &&
        reel.shortcode === incoming.shortcode &&
        reel.accountId === incoming.accountId
      )
  );

  if (index === -1) {
    db.reels.push(incoming);
    return incoming;
  }

  const existing = db.reels[index];

  const merged = {
    ...existing,
    ...incoming,

    used: existing.used || false,

    aiAnalysis:
      existing.aiAnalysis || null,

    selectedHook:
      existing.selectedHook || ""
  };

  db.reels[index] = merged;

  return merged;
}

/* -----------------------------
   HEALTH
----------------------------- */

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    version: "1.2",
    service: "clipper-backend",
    apifyConfigured: Boolean(APIFY_TOKEN),
    openrouterConfigured: Boolean(
      OPENROUTER_API_KEY
    ),
    time: now()
  });
});

/* -----------------------------
   ACCOUNTS
----------------------------- */

app.get("/api/accounts", (req, res) => {
  const db = readDb();

  res.json(db.accounts);
});

app.post("/api/accounts", (req, res) => {
  const db = readDb();

  const username = cleanUsername(
    req.body?.username
  );

  const name =
    String(req.body?.name || username).trim();

  const category =
    String(
      req.body?.category || "meme"
    ).trim();

  if (!username) {
    return res.status(400).json({
      error: "Instagram username is required."
    });
  }

  const existing = db.accounts.find(
    account =>
      cleanUsername(account.username)
        .toLowerCase() ===
      username.toLowerCase()
  );

  if (existing) {
    return res.json(existing);
  }

  const account = {
    id: id("account"),
    username,
    name,
    category,
    createdAt: now(),
    lastSync: null
  };

  db.accounts.push(account);

  writeDb(db);

  res.status(201).json(account);
});

app.delete("/api/accounts/:id", (req, res) => {
  const db = readDb();

  const accountId = req.params.id;

  db.accounts = db.accounts.filter(
    account => account.id !== accountId
  );

  db.reels = db.reels.filter(
    reel => reel.accountId !== accountId
  );

  writeDb(db);

  res.json({
    ok: true
  });
});

/* -----------------------------
   SYNC INSTAGRAM
----------------------------- */

app.post(
  "/api/accounts/:id/sync",
  async (req, res) => {
    try {
      const db = readDb();

      const account =
        db.accounts.find(
          item =>
            item.id === req.params.id
        );

      if (!account) {
        return res.status(404).json({
          error: "Account not found."
        });
      }

      const username = cleanUsername(
        account.username
      );

      if (!username) {
        return res.status(400).json({
          error:
            "Instagram username is missing."
        });
      }

      const run =
        await startApifyRun(username);

      const completed =
        await waitForApifyRun(run.id);

      if (
        completed.status !== "SUCCEEDED"
      ) {
        throw new Error(
          `Apify run ${completed.status}. Run ID: ${run.id}`
        );
      }

      const datasetId =
        completed.defaultDatasetId;

      if (!datasetId) {
        throw new Error(
          "Apify completed without a dataset ID."
        );
      }

      const items =
        await getApifyDatasetItems(
          datasetId
        );

      let imported = 0;

      for (const item of items) {
        const reel =
          normalizeReel(
            item,
            account
          );

        if (
          !reel.videoUrl &&
          !reel.permalink
        ) {
          continue;
        }

        mergeReel(
          db,
          reel
        );

        imported++;
      }

      account.lastSync = now();

      writeDb(db);

      const reels =
        db.reels.filter(
          reel =>
            reel.accountId === account.id
        );

      res.json({
        ok: true,
        account,
        runId: run.id,
        imported,
        total: reels.length,
        reels
      });
    } catch (error) {
      console.error(
        "SYNC ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Instagram sync failed."
      });
    }
  }
);

/* -----------------------------
   REELS
----------------------------- */

app.get("/api/reels", (req, res) => {
  const db = readDb();

  let reels = [...db.reels];

  if (req.query.accountId) {
    reels = reels.filter(
      reel =>
        reel.accountId ===
        req.query.accountId
    );
  }

  if (
    String(req.query.unused) ===
    "true"
  ) {
    reels = reels.filter(
      reel => !reel.used
    );
  }

  reels.sort((a, b) =>
    String(
      b.timestamp ||
      b.fetchedAt ||
      ""
    ).localeCompare(
      String(
        a.timestamp ||
        a.fetchedAt ||
        ""
      )
    )
  );

  res.json(reels);
});

/* -----------------------------
   RANDOM BATCH
----------------------------- */

app.post("/api/batch/random", (req, res) => {
  const db = readDb();

  const requested =
    Number(req.body?.count) || 10;

  const accountId =
    req.body?.accountId || null;

  let candidates =
    db.reels.filter(
      reel => !reel.used
    );

  if (accountId) {
    candidates =
      candidates.filter(
        reel =>
          reel.accountId ===
          accountId
      );
  }

  candidates.sort(
    () => Math.random() - 0.5
  );

  const selected =
    candidates.slice(
      0,
      Math.min(requested, 50)
    );

  const batch = {
    id: id("batch"),
    accountId,
    reelIds: selected.map(
      reel => reel.id
    ),
    createdAt: now()
  };

  db.batches.push(batch);

  writeDb(db);

  res.json({
    ...batch,
    reels: selected
  });
});

/* -----------------------------
   AI ANALYZE REEL
----------------------------- */

app.post(
  "/api/reels/:id/analyze",
  async (req, res) => {
    const tempRoot = path.join(
      "/tmp",
      `clipper-${crypto.randomBytes(
        8
      ).toString("hex")}`
    );

    try {
      const db = readDb();

      const reel =
        db.reels.find(
          item =>
            item.id ===
            req.params.id
        );

      if (!reel) {
        return res.status(404).json({
          error: "Reel not found."
        });
      }

      if (!reel.videoUrl) {
        return res.status(400).json({
          error:
            "This Reel has no video URL available."
        });
      }

      fs.mkdirSync(tempRoot, {
        recursive: true
      });

      const videoPath =
        path.join(
          tempRoot,
          "reel.mp4"
        );

      const framesDir =
        path.join(
          tempRoot,
          "frames"
        );

      console.log(
        `Downloading Reel ${reel.id}`
      );

      await downloadFile(
        reel.videoUrl,
        videoPath
      );

      console.log(
        "Extracting frames..."
      );

      const frames =
        await extractFrames(
          videoPath,
          framesDir
        );

      if (!frames.length) {
        throw new Error(
          "Could not extract video frames."
        );
      }

      console.log(
        `Sending ${frames.length} frames to OpenRouter...`
      );

      const analysis =
        await analyzeWithOpenRouter(
          frames,
          reel
        );

      reel.aiAnalysis =
        analysis;

      reel.selectedHook =
        analysis.hooks?.[0] || "";

      reel.analyzedAt =
        now();

      writeDb(db);

      res.json({
        ok: true,
        reelId: reel.id,
        analysis
      });
    } catch (error) {
      console.error(
        "AI ANALYZE ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "AI analysis failed."
      });
    } finally {
      try {
        fs.rmSync(
          tempRoot,
          {
            recursive: true,
            force: true
          }
        );
      } catch {}
    }
  }
);

/* -----------------------------
   RENDER REEL
----------------------------- */

app.post(
  "/api/jobs/:id/render",
  async (req, res) => {
    const tempRoot = path.join(
      "/tmp",
      `render-${crypto.randomBytes(
        8
      ).toString("hex")}`
    );

    try {
      const db = readDb();

      const reel =
        db.reels.find(
          item =>
            item.id ===
            req.params.id
        );

      if (!reel) {
        return res.status(404).json({
          error: "Reel not found."
        });
      }

      if (!reel.videoUrl) {
        return res.status(400).json({
          error:
            "This Reel has no video URL."
        });
      }

      const hook = String(
        req.body?.hook ||
        reel.selectedHook ||
        reel.aiAnalysis?.hooks?.[0] ||
        ""
      ).trim();

      if (!hook) {
        return res.status(400).json({
          error:
            "Please select a hook before rendering."
        });
      }

      fs.mkdirSync(tempRoot, {
        recursive: true
      });

      const inputPath =
        path.join(
          tempRoot,
          "input.mp4"
        );

      const outputPath =
        path.join(
          tempRoot,
          "rendered.mp4"
        );

      await downloadFile(
        reel.videoUrl,
        inputPath
      );

      /*
       * Escape text for FFmpeg drawtext.
       */
      const escapedHook =
        hook
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'")
          .replace(/:/g, "\\:")
          .replace(/%/g, "\\%")
          .replace(/\n/g, "\\n");

      const font =
        fs.existsSync(RENDER_FONT)
          ? RENDER_FONT
          : "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

      const drawtext =
        `drawtext=fontfile='${font}':` +
        `text='${escapedHook}':` +
        `fontcolor=white:` +
        `fontsize=52:` +
        `borderw=4:` +
        `bordercolor=black:` +
        `x=(w-text_w)/2:` +
        `y=h*0.12`;

      await execFileAsync(
        "ffmpeg",
        [
          "-y",
          "-i",
          inputPath,
          "-vf",
          drawtext,
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          outputPath
        ],
        {
          maxBuffer:
            20 * 1024 * 1024
        }
      );

      /*
       * Render files on Render Free are temporary.
       * For the current test version we expose
       * the file through an in-memory/local route
       * only while this server instance exists.
       *
       * We store the file under /tmp and provide
       * a local API URL.
       */

      const jobId = id("job");

      const job = {
        id: jobId,
        reelId: reel.id,
        hook,
        caption:
          req.body?.caption ||
          reel.aiAnalysis?.caption ||
          "",
        outputPath,
        createdAt: now(),
        status: "completed"
      };

      db.jobs.push(job);

      reel.selectedHook =
        hook;

      reel.used = true;

      writeDb(db);

      res.json({
        ok: true,
        jobId,
        status: "completed",
        previewUrl:
          `/api/jobs/${jobId}/file`,
        hook,
        caption: job.caption
      });
    } catch (error) {
      console.error(
        "RENDER ERROR:",
        error
      );

      res.status(500).json({
        error:
          error.message ||
          "Render failed."
      });
    }
  }
);

/* -----------------------------
   RENDERED FILE
----------------------------- */

app.get(
  "/api/jobs/:id/file",
  (req, res) => {
    const db = readDb();

    const job =
      db.jobs.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!job) {
      return res.status(404).send(
        "Render job not found."
      );
    }

    if (
      !job.outputPath ||
      !fs.existsSync(job.outputPath)
    ) {
      return res.status(404).send(
        "Rendered file is no longer available. Render Free storage is temporary."
      );
    }

    res.download(
      job.outputPath,
      "clipper-rendered.mp4"
    );
  }
);

/* -----------------------------
   JOB STATUS
----------------------------- */

app.get(
  "/api/jobs/:id",
  (req, res) => {
    const db = readDb();

    const job =
      db.jobs.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!job) {
      return res.status(404).json({
        error: "Job not found."
      });
    }

    res.json(job);
  }
);

/* -----------------------------
   BATCHES
----------------------------- */

app.get("/api/batches", (req, res) => {
  const db = readDb();

  const batches =
    db.batches.map(batch => ({
      ...batch,

      reels:
        batch.reelIds
          .map(reelId =>
            db.reels.find(
              reel =>
                reel.id ===
                reelId
            )
          )
          .filter(Boolean)
    }));

  res.json(batches);
});

app.get(
  "/api/batches/:id",
  (req, res) => {
    const db = readDb();

    const batch =
      db.batches.find(
        item =>
          item.id ===
          req.params.id
      );

    if (!batch) {
      return res.status(404).json({
        error: "Batch not found."
      });
    }

    const reels =
      batch.reelIds
        .map(reelId =>
          db.reels.find(
            reel =>
              reel.id ===
              reelId
          )
        )
        .filter(Boolean);

    res.json({
      ...batch,
      reels
    });
  }
);

/* -----------------------------
   404
----------------------------- */

app.use(
  (req, res) => {
    res.status(404).json({
      error: "Not found",
      path: req.path
    });
  }
);

/* -----------------------------
   START
----------------------------- */

ensureDb();

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `Clipper backend V1.2 running on port ${PORT}`
    );

    console.log(
      `Apify configured: ${Boolean(
        APIFY_TOKEN
      )}`
    );

    console.log(
      `OpenRouter configured: ${Boolean(
        OPENROUTER_API_KEY
      )}`
    );
  }
);
