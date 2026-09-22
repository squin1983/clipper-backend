import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWorker } from 'tesseract.js';

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
  try { return JSON.parse(await fs.readFile(DB_FILE, 'utf8')); }
  catch { return { accounts: [], reels: [], batches: [], jobs: [] }; }
}
async function saveDb(db) { await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2)); }
function id(prefix='id') { return `${prefix}_${crypto.randomUUID()}`; }
function cleanUsername(v) { return String(v || '').trim().replace(/^@/, '').toLowerCase(); }
function shuffle(a) { const x=[...a]; for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];} return x; }

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || true }));
app.use('/media', express.static(RENDERED));

app.get('/api/health', (_req,res)=>res.json({ ok:true, version:'1.0-horizontal' }));
app.get('/api/accounts', async (_req,res)=>{ const db=await loadDb(); res.json(db.accounts); });

app.post('/api/accounts', async (req,res)=>{
  const username=cleanUsername(req.body.username); const category=req.body.category;
  if(!username || !['meme','movie_tv','music'].includes(category)) return res.status(400).json({error:'username and category are required'});
  const db=await loadDb();
  let a=db.accounts.find(x=>x.username===username);
  if(a) { a.category=category; await saveDb(db); return res.json(a); }
  a={id:id('acct'),username,category,active:true,createdAt:new Date().toISOString()}; db.accounts.push(a); await saveDb(db); res.json(a);
});

async function apifyActor(input) {
  if(!process.env.APIFY_TOKEN) throw new Error('APIFY_TOKEN is not configured on the server');
  const actor='instagram-scraper~instagram-profile-reels-scraper';
  const r=await fetch(`https://api.apify.com/v2/acts/${actor}/runs?token=${encodeURIComponent(process.env.APIFY_TOKEN)}&waitForFinish=120`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
  if(!r.ok) throw new Error(`Apify start failed: ${r.status}`);
  const run=await r.json();
  const datasetId=run?.data?.defaultDatasetId;
  if(!datasetId) throw new Error('Apify did not return a dataset');
  const d=await fetch(`https://api.apify.com/v2/datasets/${datasetId}/items?token=${encodeURIComponent(process.env.APIFY_TOKEN)}&clean=true`);
  if(!d.ok) throw new Error(`Apify dataset failed: ${d.status}`);
  return await d.json();
}

app.post('/api/accounts/:id/sync', async (req,res)=>{
  const db=await loadDb(); const account=db.accounts.find(x=>x.id===req.params.id); if(!account) return res.status(404).json({error:'account not found'});
  try {
    const items=await apifyActor({ instagramUsernames:[account.username], resultsLimit:100 });
    let added=0;
    for(const item of items){
      const reelId=String(item.id || item.shortCode || item.url || item.pk || ''); if(!reelId) continue;
      const videoUrl=item.videoUrl || item.video_url || item.displayUrl || item.url;
      if(!videoUrl) continue;
      if(!db.reels.some(r=>r.id===reelId)) { db.reels.push({id:reelId,sourceId:account.id,username:account.username,category:account.category,permalink:item.url||item.permalink||'',videoUrl,caption:item.caption||'',used:false,reserved:false,createdAt:item.timestamp||new Date().toISOString()}); added++; }
    }
    account.lastSyncAt=new Date().toISOString(); await saveDb(db); res.json({account,added,total:db.reels.filter(r=>r.sourceId===account.id).length});
  } catch(e) { res.status(502).json({error:e.message}); }
});

app.post('/api/batch/random', async (req,res)=>{
  const db=await loadDb(); const pool=db.reels.filter(r=>!r.used&&!r.reserved); const chosen=shuffle(pool).slice(0,10);
  if(chosen.length<10) return res.status(409).json({error:`Only ${chosen.length} unused Reels are available; need 10.`});
  const batch={id:id('batch'),createdAt:new Date().toISOString(),count:chosen.length,status:'selected'};
  for(const r of chosen) r.reserved=true;
  const jobs=chosen.map(r=>({id:id('job'),batchId:batch.id,reelId:r.id,status:'selected',hook:'',caption:r.caption||'',outputUrl:null,error:null}));
  db.batches.push(batch); db.jobs.push(...jobs); await saveDb(db); res.json({batch,jobs,reels:chosen});
});

async function download(url,out) {
  const r=await fetch(url,{redirect:'follow'}); if(!r.ok) throw new Error(`Video download failed: ${r.status}`);
  const buf=Buffer.from(await r.arrayBuffer()); if(buf.length<1000) throw new Error('Downloaded video is too small'); await fs.writeFile(out,buf);
}
async function renderVideo(input,output,hook) {
  const safe=String(hook||'').replace(/\\/g,'\\\\').replace(/'/g,"\\'").replace(/:/g,'\\:').replace(/%/g,'\\%');
  const vf=`scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,drawtext=text='${safe}':fontcolor=white:fontsize=46:borderw=3:bordercolor=black:x=(w-text_w)/2:y=34`;
  await exec('ffmpeg',['-y','-i',input,'-vf',vf,'-c:v','libx264','-preset','veryfast','-crf','22','-c:a','aac','-b:a','128k','-movflags','+faststart',output],{maxBuffer:1024*1024*10});
}

app.post('/api/jobs/:id/render', async (req,res)=>{
  const db=await loadDb(); const job=db.jobs.find(x=>x.id===req.params.id); if(!job) return res.status(404).json({error:'job not found'});
  const reel=db.reels.find(x=>x.id===job.reelId); if(!reel) return res.status(404).json({error:'reel not found'});
  job.status='rendering'; job.hook=String(req.body.hook||''); job.caption=String(req.body.caption ?? reel.caption ?? ''); await saveDb(db);
  try {
    const base=`${job.id}`; const input=path.join(RAW,`${base}.mp4`); const output=path.join(RENDERED,`${base}.mp4`);
    await download(reel.videoUrl,input);
    // OCR is intentionally initialized here for the first processing pass; hook rendering remains safe if OCR cannot initialize.
    try { const worker=await createWorker('eng'); await worker.terminate(); } catch {}
    await renderVideo(input,output,job.hook);
    job.status='ready'; job.outputUrl=`/media/${base}.mp4`; reel.reserved=false; reel.used=true; await saveDb(db); res.json(job);
  } catch(e) { job.status='error'; job.error=e.message; reel.reserved=false; await saveDb(db); res.status(500).json({error:e.message,job}); }
});

app.get('/api/jobs/:id', async (req,res)=>{ const db=await loadDb(); const j=db.jobs.find(x=>x.id===req.params.id); if(!j) return res.status(404).json({error:'job not found'}); res.json(j); });
app.get('/api/batches/:id', async (req,res)=>{ const db=await loadDb(); const b=db.batches.find(x=>x.id===req.params.id); if(!b) return res.status(404).json({error:'batch not found'}); res.json({batch:b,jobs:db.jobs.filter(x=>x.batchId===b.id)}); });

app.listen(PORT,'0.0.0.0',()=>console.log(`Clipper backend listening on ${PORT}`));
