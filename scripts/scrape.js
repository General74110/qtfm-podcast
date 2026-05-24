// Qtfm Podcast Scraper v2 - 全量爬取（遍历nextProgramId链）
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) { console.error('CHANNEL_ID required'); process.exit(1); }
const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.general74110.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

async function httpGet(url, acceptJSON, retries) {
  retries = retries || 3;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await httpGetOnce(url, acceptJSON);
    } catch(e) {
      if (attempt < retries) {
        const wait = 2000 * attempt;
        console.log('  Retry ' + attempt + '/' + retries + ' for ' + url.slice(0,80) + '... wait ' + wait + 'ms');
        await sleep(wait);
      } else {
        throw e;
      }
    }
  }
}

function httpGetOnce(url, acceptJSON) {
  return new Promise((ok, fail) => {
    const mod = url.startsWith('https') ? https : http;
    const headers = acceptJSON
      ? { 'User-Agent': UA, 'Accept': 'application/json', 'Origin': 'https://m.qtfm.cn', 'Referer': 'https://m.qtfm.cn/' }
      : { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Referer': 'https://m.qtfm.cn/' };
    const req = mod.get(url, { headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode !== 200) fail(new Error('HTTP ' + res.statusCode));
        else ok(acceptJSON ? JSON.parse(d) : d);
      });
    });
    req.on('error', err => fail(err));
    req.setTimeout(45000, function() { this.destroy(); });
  });
}

function extractInitStores(html) {
  const m = html.match(/window\.__initStores\s*=\s*(\{)/);
  if (!m) return null;
  const str = html.slice(m.index + m[0].length - 1);
  let d = 0, ins = false, esc = false, end = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && ins) { esc = true; continue; }
    if (c === '"') { ins = !ins; continue; }
    if (ins) continue;
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) { end = i + 1; break; } }
  }
  if (end === 0) return null;
  try { return JSON.parse(str.slice(0, end)); } catch (_) { return null; }
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h > 0 ? h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0')
    : m + ':' + String(s).padStart(2,'0');
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('[' + CHANNEL_ID + '] Starting full scrape...');
  const startTime = Date.now();

  // 1. 获取频道元数据 + 前30集
  const html = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/');
  const data = extractInitStores(html);
  if (!data?.VChannelStore?.channel) throw new Error('Parse failed');

  const ch = data.VChannelStore.channel;
  const ver = ch.v || '';
  const title = ch.title || 'Unknown';
  const desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
  const cover = ch.cover ? ch.cover + '!400' : '';
  console.log('Title: ' + title + ', Total on site: ' + (ch.program_count || 0));

  // 2. 获取所有节目ID（顺着nextProgramId链遍历）
  let allProgs = [];
  const seenIds = new Set();

  // 先拿前30集（含节目信息）
  let batch = [];
  if (ver) {
    try {
      const api = await httpGet('https://webapi.qtfm.cn/api/mobile/channels/' + CHANNEL_ID + '/programs?version=' + ver, true);
      if (api.programs) batch = api.programs;
    } catch(e) { console.log('API fail:', e.message); }
  }
  if (batch.length === 0) batch = data.VChannelStore.programs?.items || [];

  console.log('Initial batch: ' + batch.length + ' episodes');

  // 收集这30集
  for (const p of batch) {
    if (!seenIds.has(p.programId)) {
      seenIds.add(p.programId);
      allProgs.push({ programId: p.programId, title: p.title, duration: p.duration, updateTime: p.updateTime });
    }
  }

  // 用最后一集的nextProgramId继续往下走
  let lastId = batch.length > 0 ? batch[batch.length - 1].programId : null;
  let walkedCount = 0;
  const MAX_WALK = 10000;

  while (lastId && walkedCount < MAX_WALK) {
    try {
      const html2 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + lastId + '/');
      const pd = extractInitStores(html2);
      if (!pd?.ProgramStore?.programInfo) break;

      const pi = pd.ProgramStore.programInfo;
      const nextId = pi.nextProgramId;

      if (nextId && !seenIds.has(nextId)) {
        // 新节目，需要再抓下一页获取它的信息
        const html3 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + nextId + '/');
        const pd2 = extractInitStores(html3);
        if (pd2?.ProgramStore?.programInfo) {
          const pi2 = pd2.ProgramStore.programInfo;
          seenIds.add(nextId);
          allProgs.push({
            programId: nextId,
            title: pi2.title || 'Unknown',
            duration: pi2.duration || 0,
            updateTime: pi2.updateTime || null
          });
          lastId = nextId;
          walkedCount++;
        } else { break; }

        // 同时也看看siblingPrograms里有没有新的（每30集停一次）
        const siblings = pd2?.ProgramStore?.siblingPrograms || [];
        for (const sp of siblings) {
          if (!seenIds.has(sp.programId)) {
            seenIds.add(sp.programId);
            allProgs.push({
              programId: sp.programId,
              title: sp.title,
              duration: sp.duration || 0,
              updateTime: sp.updateTime || null
            });
          }
        }
      } else { break; }

      if (walkedCount % 50 === 0) {
        console.log('  Walked: ' + walkedCount + ', total: ' + allProgs.length + ', next: ' + lastId);
      }

      await sleep(150);
    } catch(e) {
      console.log('  Walk break at ' + walkedCount + ': ' + e.message);
      break;
    }
  }

  console.log('Total episodes found: ' + allProgs.length + ' (walked ' + walkedCount + ' steps)');

  if (allProgs.length === 0) throw new Error('No episodes');

  // 3. 获取音频URL（按原始顺序）
  console.log('Fetching audio URLs for ' + allProgs.length + ' episodes...');
  const audio = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < allProgs.length; i++) {
    const pid = allProgs[i].programId;
    if (!pid) { fail++; continue; }
    try {
      const html2 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/');
      const am = html2.match(/"audioUrl"\s*:\s*"([^"]+)"/);
      if (am) {
        const ep = am[1].replace(/\\u0026/g, '&');
        try {
          const html3 = await httpGet(ep);
          const hm = html3.match(/href="([^"]+)"/);
          audio[pid] = hm ? hm[1] : ep;
        } catch(_) { audio[pid] = ep; }
        ok++;
      } else { fail++; }
    } catch(_) { fail++; }
    if ((i + 1) % 50 === 0 || i === allProgs.length - 1) {
      const pct = ((i + 1) / allProgs.length * 100).toFixed(0);
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log('  Audio: ' + (i+1) + '/' + allProgs.length + ' (' + pct + '%) OK=' + ok + ' FAIL=' + fail + ' elapsed=' + elapsed + 's');
    }
    if (i < allProgs.length - 1) await sleep(80);
  }
  console.log('Audio done: ' + ok + ' OK, ' + fail + ' FAIL');

  // 4. 生成RSS
  const now = new Date().toUTCString();
  let items = '';
  for (const p of allProgs) {
    const pid = p.programId;
    if (!pid) continue;
    const au = audio[pid] || WORKER_BASE + '/audio/' + CHANNEL_ID + '/' + pid;
    const du = fmtDur(p.duration || 0);
    const dt = p.updateTime ? new Date(p.updateTime).toUTCString() : now;
    const pt = p.title || '';
    const pu = 'https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/';
    items += '    <item>\n      <title>' + esc(pt) + '</title>\n';
    items += '      <link>' + esc(pu) + '</link>\n';
    items += '      <guid isPermaLink="false">qtfm-' + CHANNEL_ID + '-' + pid + '</guid>\n';
    items += '      <description>' + esc(pt) + '</description>\n';
    items += '      <enclosure url="' + esc(au) + '" length="0" type="audio/mpeg"/>\n';
    items += '      <itunes:duration>' + du + '</itunes:duration>\n';
    items += '      <itunes:author>蜻蜓FM</itunes:author>\n';
    items += '      <pubDate>' + dt + '</pubDate>\n    </item>\n';
  }

  const rss = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">\n  <channel>\n' +
    '    <title>' + esc(title) + '</title>\n    <link>https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/</link>\n' +
    '    <description>' + esc(desc) + '</description>\n    <language>zh-cn</language>\n' +
    '    <itunes:author>蜻蜓FM</itunes:author>\n    <itunes:summary>' + esc(desc) + '</itunes:summary>\n' +
    (cover ? '    <itunes:image href="' + esc(cover) + '"/>\n' : '') +
    '    <itunes:category text="有声书"/>\n    <lastBuildDate>' + now + '</lastBuildDate>\n' +
    '    <pubDate>' + now + '</pubDate>\n' + items + '  </channel>\n</rss>\n';

  // 5. 写入文件
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.xml'), rss, 'utf8');
  const meta = {
    channelId: CHANNEL_ID, title, programs: allProgs.length,
    audioOk: ok, audioFail: fail,
    totalOnSite: ch.program_count || 0,
    generatedAt: now,
    duration: Math.round((Date.now() - startTime) / 1000) + 's'
  };
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.json'), JSON.stringify(meta, null, 2), 'utf8');

  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch(_) {}
  const ex = idx.find(i => i.channelId === CHANNEL_ID);
  if (ex) Object.assign(ex, meta); else idx.push(meta);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');

  const elapsed = Math.round((Date.now() - startTime) / 1000);
  console.log('Done: ' + allProgs.length + ' eps, ' + (rss.length/1024).toFixed(0) + 'KB, ' + elapsed + 's');
}

main().catch(e => {
  if (e && e.errors) console.error('FAIL: Aggregate', e.errors.map(x => x.message || x.code || String(x)).join(', '));
  else if (e && e.code) console.error('FAIL:', e.code, e.message || '');
  else console.error('FAIL:', e && (e.message || e.stack || String(e)) || 'unknown');
  process.exit(1);
});