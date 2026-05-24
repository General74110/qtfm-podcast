// Qtfm Podcast Scraper v3 - 用curl绕过runner网络问题
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHANNEL_ID = process.env.CHANNEL_ID;
if (!CHANNEL_ID) { console.error('CHANNEL_ID required'); process.exit(1); }
const WORKER_BASE = process.env.WORKER_BASE || 'https://qtfm-podcast.general74110.workers.dev';
const OUT_DIR = process.env.OUT_DIR || 'novels';

const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36';

function curl(url, acceptJSON) {
  const ua = acceptJSON
    ? '"User-Agent: ' + UA + '" -H "Accept: application/json" -H "Origin: https://m.qtfm.cn" -H "Referer: https://m.qtfm.cn/"'
    : '"User-Agent: ' + UA + '" -H "Accept: text/html,application/xhtml+xml" -H "Referer: https://m.qtfm.cn/"';
  const cmd = 'curl -sL --connect-timeout 30 --max-time 60 -H ' + ua + ' ' + JSON.stringify(url);
  return execSync(cmd, { encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function httpGet(url, acceptJSON, retries) {
  retries = retries || 5;
  const errors = [];
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const result = curl(url, acceptJSON);
      if (!result && result !== '') throw new Error('empty response');
      if (acceptJSON) return JSON.parse(result);
      return result;
    } catch(e) {
      errors.push(e.message);
      if (attempt < retries) {
        const wait = 3000 * attempt;
        console.log('  [' + attempt + '/' + retries + '] retrying ' + url.slice(0,60) + '...');
        execSync('sleep ' + (wait/1000));
      }
    }
  }
  throw new Error(errors.join(' | '));
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

function fmtDur(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), s2 = s % 60;
  return h > 0 ? h + ':' + String(m).padStart(2,'0') + ':' + String(s2).padStart(2,'0')
    : m + ':' + String(s2).padStart(2,'0');
}

function esc(s) {
  if (!s) return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function main() {
  console.log('[' + CHANNEL_ID + '] Starting with curl...');
  const startTime = Date.now();

  const html = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/');
  const data = extractInitStores(html);
  if (!data?.VChannelStore?.channel) throw new Error('Parse failed');

  const ch = data.VChannelStore.channel;
  const ver = ch.v || '';
  const title = ch.title || 'Unknown';
  const desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
  const cover = ch.cover ? ch.cover + '!400' : '';
  console.log('Title: ' + title + ', Total: ' + (ch.program_count || 0));

  let allProgs = [];
  const seenIds = new Set();

  let batch = [];
  if (ver) {
    try {
      const api = await httpGet('https://webapi.qtfm.cn/api/mobile/channels/' + CHANNEL_ID + '/programs?version=' + ver, true);
      if (api.programs) batch = api.programs;
    } catch(e) { console.log('API fail:', e.message); }
  }
  if (batch.length === 0) batch = data.VChannelStore.programs?.items || [];
  console.log('Initial: ' + batch.length + ' eps');

  for (const p of batch) {
    if (!seenIds.has(p.programId)) {
      seenIds.add(p.programId);
      allProgs.push({ programId: p.programId, title: p.title, duration: p.duration, updateTime: p.updateTime });
    }
  }

  // Walk nextProgramId chain
  let lastId = batch.length > 0 ? batch[batch.length - 1].programId : null;
  let walked = 0;

  while (lastId && walked < 20000) {
    try {
      const h2 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + lastId + '/');
      const pd = extractInitStores(h2);
      if (!pd?.ProgramStore?.programInfo) break;
      const nextId = pd.ProgramStore.programInfo.nextProgramId;
      if (!nextId || seenIds.has(nextId)) break;

      const h3 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + nextId + '/');
      const pd2 = extractInitStores(h3);
      if (pd2?.ProgramStore?.programInfo) {
        const pi = pd2.ProgramStore.programInfo;
        seenIds.add(nextId);
        allProgs.push({ programId: nextId, title: pi.title || '', duration: pi.duration || 0, updateTime: pi.updateTime || null });
        lastId = nextId;
        walked++;
      } else break;

      const sibs = pd2?.ProgramStore?.siblingPrograms || [];
      for (const sp of sibs) {
        if (!seenIds.has(sp.programId)) {
          seenIds.add(sp.programId);
          allProgs.push({ programId: sp.programId, title: sp.title, duration: sp.duration || 0, updateTime: sp.updateTime || null });
        }
      }
    } catch(e) {
      console.log('  Walk stopped at ' + walked + ': ' + e.message);
      break;
    }
    if (walked % 50 === 0) console.log('  Walk: ' + walked + ', total: ' + allProgs.length);
    execSync('sleep 0.15');
  }

  console.log('Total: ' + allProgs.length + ' eps (walked ' + walked + ')');
  if (allProgs.length === 0) throw new Error('No episodes');

  // Audio URLs
  console.log('Fetching audio URLs...');
  const audio = {};
  let ok = 0, fail = 0;

  for (let i = 0; i < allProgs.length; i++) {
    const pid = allProgs[i].programId;
    try {
      const h2 = await httpGet('https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/');
      const am = h2.match(/"audioUrl"\s*:\s*"([^"]+)"/);
      if (am) {
        const ep = am[1].replace(/\\u0026/g, '&');
        try {
          const h3 = await httpGet(ep);
          const hm = h3.match(/href="([^"]+)"/);
          audio[pid] = hm ? hm[1] : ep;
        } catch(_) { audio[pid] = ep; }
        ok++;
      } else { fail++; }
    } catch(_) { fail++; }
    if ((i + 1) % 50 === 0 || i === allProgs.length - 1) {
      const pct = ((i + 1) / allProgs.length * 100).toFixed(0);
      const el = Math.round((Date.now() - startTime) / 1000);
      console.log('  Audio: ' + (i+1) + '/' + allProgs.length + ' (' + pct + '%) OK=' + ok + ' FAIL=' + fail + ' ' + el + 's');
    }
    execSync('sleep 0.08');
  }
  console.log('Audio: ' + ok + ' OK, ' + fail + ' FAIL');

  // RSS
  const now = new Date().toUTCString();
  let items = '';
  for (const p of allProgs) {
    const pid = p.programId;
    if (!pid) continue;
    const au = audio[pid] || WORKER_BASE + '/audio/' + CHANNEL_ID + '/' + pid;
    items += '    <item>\n      <title>' + esc(p.title) + '</title>\n';
    items += '      <link>https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/programs/' + pid + '/</link>\n';
    items += '      <guid isPermaLink="false">qtfm-' + CHANNEL_ID + '-' + pid + '</guid>\n';
    items += '      <description>' + esc(p.title) + '</description>\n';
    items += '      <enclosure url="' + esc(au) + '" length="0" type="audio/mpeg"/>\n';
    items += '      <itunes:duration>' + fmtDur(p.duration || 0) + '</itunes:duration>\n';
    items += '      <itunes:author>蜻蜓FM</itunes:author>\n';
    items += '      <pubDate>' + (p.updateTime ? new Date(p.updateTime).toUTCString() : now) + '</pubDate>\n    </item>\n';
  }

  const rss = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" version="2.0">\n  <channel>\n' +
    '    <title>' + esc(title) + '</title>\n    <link>https://m.qtfm.cn/vchannels/' + CHANNEL_ID + '/</link>\n' +
    '    <description>' + esc(desc) + '</description>\n    <language>zh-cn</language>\n    <itunes:author>蜻蜓FM</itunes:author>\n' +
    '    <itunes:summary>' + esc(desc) + '</itunes:summary>\n' +
    (cover ? '    <itunes:image href="' + esc(cover) + '"/>\n' : '') +
    '    <itunes:category text="有声书"/>\n    <lastBuildDate>' + now + '</lastBuildDate>\n    <pubDate>' + now + '</pubDate>\n' +
    items + '  </channel>\n</rss>\n';

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.xml'), rss, 'utf8');
  const meta = { channelId: CHANNEL_ID, title, programs: allProgs.length, audioOk: ok, audioFail: fail, generatedAt: now,
    duration: Math.round((Date.now() - startTime) / 1000) + 's' };
  fs.writeFileSync(path.join(OUT_DIR, CHANNEL_ID + '.json'), JSON.stringify(meta, null, 2), 'utf8');

  let idx = [];
  try { idx = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'index.json'), 'utf8')); } catch(_) {}
  const ex = idx.find(i => i.channelId === CHANNEL_ID);
  if (ex) Object.assign(ex, meta); else idx.push(meta);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(idx, null, 2), 'utf8');

  console.log('Done: ' + allProgs.length + ' eps, ' + (rss.length/1024).toFixed(0) + 'KB, ' + meta.duration);
}

main().catch(e => { console.error('FAIL:', e && (e.message || String(e)) || 'unknown'); process.exit(1); });