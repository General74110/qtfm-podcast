const fs = require('fs');
let code = fs.readFileSync('scripts/scrape.js', 'utf8');

// 替换搜索逻辑
const oldSearch = `  if (!ch) {
    // SSR为空，从SEO获取
    const seo = data?.VChannelStore?.seo || [];
    const seoTitle = seo.find(s => s.elementType === 'title')?.innerText || '';
    title = seoTitle.replace(/\\s*有声小说在线收听.*$/, '') || 'Channel ' + CHANNEL_ID;
    desc = seo.find(s => s.elementType === 'meta' && s.name === 'description')?.content?.slice(0,200) || title;
    console.log('SSR empty, SEO title: ' + title);
    // 搜索替代频道
    const kw = encodeURIComponent(title.replace(/\\s*\\(.*?\\)\\s*/, '').trim());
    try {
      const sr = await httpGetJSON('https://webapi.qtfm.cn/api/mobile/search/keyword/' + kw + '?page=1&pageSize=5');
      const channels = sr?.channels?.data || [];
      const best = channels.sort((a,b) => (b.program_count||0)-(a.program_count||0))[0];
      if (best?.id) {
        const h2 = await httpGet('https://m.qtfm.cn/vchannels/' + best.id + '/');
        const d2 = extractInitStores(h2);
        if (d2?.VChannelStore?.channel?.id) {
          ch = d2.VChannelStore.channel;
          ver = ch.v || '';
          title = ch.title || title;
          desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
          cover = ch.cover ? ch.cover + '!400' : '';
          console.log('Using channel ' + best.id + ': ' + title + ', ' + (ch.program_count||0) + ' eps');
        }
      }
    } catch(e) { console.log('Search failed:', e.message); }
    if (!ch) throw new Error('Cannot find channel content');
  }`;

const newSearch = `  if (!ch) {
    // SSR为空，从SEO获取
    const seo = data?.VChannelStore?.seo || [];
    const seoTitle = seo.find(s => s.elementType === 'title')?.innerText || '';
    title = seoTitle.replace(/\\s*有声小说在线收听.*$/, '') || 'Channel ' + CHANNEL_ID;
    desc = seo.find(s => s.elementType === 'meta' && s.name === 'description')?.content?.slice(0,200) || title;
    console.log('SSR empty, SEO title: ' + title);
    // 搜索替代频道
    const kw = encodeURIComponent(title.replace(/\\s*\\(.*?\\)\\s*/, '').trim());
    try {
      const sr = await httpGetJSON('https://webapi.qtfm.cn/api/mobile/search/keyword/' + kw + '?page=1&pageSize=10');
      const channels = sr?.channels?.data || [];
      // 逐个验证，找到有SSR数据的频道
      for (const candidate of channels) {
        if (!candidate?.id) continue;
        try {
          const h2 = await httpGet('https://m.qtfm.cn/vchannels/' + candidate.id + '/');
          const d2 = extractInitStores(h2);
          if (d2?.VChannelStore?.channel?.id && d2.VChannelStore.programs?.total > 0) {
            ch = d2.VChannelStore.channel;
            ver = ch.v || '';
            title = ch.title || candidate.title || title;
            desc = (ch.description || title).replace(/<[^>]+>/g, '').trim();
            cover = ch.cover ? ch.cover + '!400' : '';
            console.log('Found real channel: ' + candidate.id + ' (' + title + ', ' + (ch.program_count||0) + ' eps)');
            break;
          }
        } catch(e) { /* try next */ }
      }
    } catch(e) { console.log('Search failed:', e.message); }
    if (!ch) throw new Error('Cannot find channel content');
  }`;

code = code.replace(oldSearch, newSearch);
fs.writeFileSync('scripts/scrape.js', code);
console.log('Patched');
