// Text helpers shared by the filter, the deduper and the market matcher.

const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have how i if in into is it its
just more most new no not now of on or our out over says said so than that the their them then there these they this to
up us was we were what when where which who why will with would you your after about all also amid back before being
between both during each first get gets got here last like make makes many may much must next off once only other own
same should since some still such take through under until very via vs week year years day days today report reports
announces announced launch launches launched introducing introduces says new update updates using use used way ways`.split(/\s+/));

export function decodeEntities(s = '') {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;|&rsquo;|&lsquo;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"').replace(/&mdash;/g, '—').replace(/&ndash;/g, '–').replace(/&hellip;/g, '…');
}

export function stripHtml(s = '') {
  return decodeEntities(String(s).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function clip(s = '', n = 280) {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, cut.lastIndexOf(' ') > n * 0.6 ? cut.lastIndexOf(' ') : n).replace(/[,.;:\s]+$/, '') + '…';
}

export function tokens(s = '') {
  return s
    .toLowerCase()
    .replace(/[’']s\b/g, '')
    .replace(/[^a-z0-9.+\- ]+/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^[.\-+]+|[.\-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOP.has(t));
}

// Canonical URL used for exact-duplicate detection across sources.
export function canonicalUrl(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|ref|source|fbclid|gclid|mc_|cmpid|smid|s$|t$)/i.test(k)) url.searchParams.delete(k);
    }
    url.hostname = url.hostname.replace(/^(www|m|mobile|amp)\./, '');
    if (url.hostname === 'twitter.com') url.hostname = 'x.com';
    let s = url.toString().replace(/\/$/, '');
    s = s.replace(/^http:/, 'https:');
    return s;
  } catch {
    return u;
  }
}

export function hostOf(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

// Strings like "Title - Outlet" from Google News.
export function splitOutlet(title) {
  const m = title.match(/^(.*\S)\s+[-–—|]\s+([^-–—|]{2,60})$/);
  return m ? { title: m[1], outlet: m[2] } : { title, outlet: null };
}
