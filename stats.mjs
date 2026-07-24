/**
 * Front Office — live stats, on Netlify
 *
 *   GET /stats?week=N&season=YYYY  ->  { games, stats }
 *
 * Same payload the Cloudflare Worker returns, same Sleeper stat keys, so the
 * page cannot tell which one it is talking to.
 */

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
};
const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra }
  });

export default async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  const url = new URL(req.url);
  const week = Math.max(1, Math.min(22, Number(url.searchParams.get('week')) || 1));
  const season = Number(url.searchParams.get('season')) || new Date().getUTCFullYear();
  const provider = String(process.env.STATS_PROVIDER || 'espn').toLowerCase();

  try {
    const payload = provider === 'rotoballer'
      ? await fromRotoBaller(process.env, season, week)
      : await fromESPN(season, week);
    // Netlify caches this at the edge, so twelve people watching one game is
    // still one call out to the provider.
    return json(payload, 200, { 'cache-control': 'public, max-age=20' });
  } catch (e) {
    return json({ error: String(e?.message || e) }, 502);
  }
};

export const config = { path: '/stats' };

/**
 * RotoBaller Game Center adapter — deliberately left as a stub.
 *
 * What's actually true about that page, as of this writing:
 *   • The scoreboard is drawn in the browser, so there is no table in the HTML
 *     to parse. The numbers arrive from an internal request that RotoBaller
 *     does not publish or support, and which can change any week.
 *   • The page is ad-supported and the site asks readers not to strip the ads.
 *     Pulling the data around the page works against that.
 *   • It covers offensive players only — no kickers and no team defenses — so
 *     two of your roster slots would never score.
 *   • RotoBaller does license data to partners (player news, injuries,
 *     projections, rankings). If you want to use their numbers properly,
 *     ask them for access: https://www.rotoballer.com/partners
 *
 * If you get partner access, put the call here and return the same shape the
 * ESPN adapter returns. Nothing else in the app has to change.
 */
async function fromRotoBaller(env, season, week) {
  if (!env.ROTOBALLER_URL) {
    return {
      games: [], stats: {}, source: 'rotoballer',
      note: 'No RotoBaller feed configured. Set ROTOBALLER_URL and fill in fromRotoBaller(), or leave STATS_PROVIDER on espn.'
    };
  }
  const r = await fetch(env.ROTOBALLER_URL, {
    headers: { accept: 'application/json', ...(env.ROTOBALLER_KEY ? { authorization: 'Bearer ' + env.ROTOBALLER_KEY } : {}) }
  });
  if (!r.ok) throw new Error('rotoballer feed said ' + r.status);
  const raw = await r.json();

  // ── map their fields onto ours here ──
  // Key names below are Sleeper's, which is what the app scores against.
  const stats = {};
  for (const row of (raw.players || raw.data || [])) {
    const name = row.name || row.player;
    if (!name) continue;
    stats[name] = {
      pass_yd: num(row.pass_yds), pass_td: num(row.pass_td), pass_int: num(row.int),
      rush_yd: num(row.rush_yds), rush_td: num(row.rush_td),
      rec: num(row.rec), rec_yd: num(row.rec_yds), rec_td: num(row.rec_td),
      fum_lost: num(row.fum_lost)
    };
  }
  return { games: raw.games || [], stats, source: 'rotoballer', week, season };
}

/**
 * ESPN adapter — free, no key, and it covers kickers and team defenses.
 * These endpoints are public but undocumented, so treat them as a convenience
 * rather than a guarantee.
 */
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';

async function fromESPN(season, week) {
  const sb = await (await fetch(`${ESPN}/scoreboard?seasontype=2&week=${week}&dates=${season}`)).json();
  const events = sb.events || [];
  const games = [];
  const stats = {};

  await Promise.all(events.map(async ev => {
    const comp = (ev.competitions || [])[0];
    if (!comp) return;
    const home = comp.competitors.find(c => c.homeAway === 'home') || {};
    const away = comp.competitors.find(c => c.homeAway === 'away') || {};
    const st = ev.status || {};
    const state = (st.type && st.type.state) || 'pre';

    const g = {
      id: String(ev.id),
      home: (home.team || {}).abbreviation || '',
      away: (away.team || {}).abbreviation || '',
      hs: Number(home.score) || 0,
      as: Number(away.score) || 0,
      q: st.period || 1,
      clock: clockSeconds(st.displayClock),
      status: state === 'post' ? 'final' : state === 'in' ? 'live' : 'pre'
    };
    games.push(g);
    if (g.status === 'pre') return;

    const sum = await (await fetch(`${ESPN}/summary?event=${ev.id}`)).json().catch(() => null);
    if (sum) boxScore(sum, stats, g);
  }));

  games.sort((a, b) => a.id.localeCompare(b.id));
  return { games, stats, source: 'espn', week, season };
}

const num = v => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
};
function clockSeconds(disp) {
  const m = /^(\d+):(\d+)$/.exec(String(disp || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : 0;
}
const pick = (labels, want, row) => {
  const i = labels.findIndex(l => String(l).toUpperCase() === want);
  return i < 0 ? 0 : num(row[i]);
};

/* Emits Sleeper's stat keys, which is exactly what the app scores against. */
function boxScore(sum, stats, game) {
  const teams = (sum.boxscore && sum.boxscore.players) || [];
  const teamYards = {};
  for (const tb of ((sum.boxscore && sum.boxscore.teams) || [])) {
    const ab = (tb.team || {}).abbreviation || '';
    const ty = (tb.statistics || []).find(x => String(x.name) === 'totalYards');
    if (ab) teamYards[ab] = num(ty && ty.displayValue);
  }
  const add = (name, k, v) => {
    if (!name || !v) return;
    stats[name] = stats[name] || {};
    stats[name][k] = (stats[name][k] || 0) + v;
  };

  for (const block of teams) {
    const abbr = (block.team || {}).abbreviation || '';
    const short = (block.team || {}).shortDisplayName || (block.team || {}).name || abbr;
    const dstName = short + ' D/ST';
    const oppAbbr = abbr === game.home ? game.away : game.home;
    stats[dstName] = stats[dstName] || {};
    stats[dstName].pts_allow = abbr === game.home ? game.as : game.hs;
    if (teamYards[oppAbbr] != null) stats[dstName].yds_allow = teamYards[oppAbbr];

    for (const cat of (block.statistics || [])) {
      const type = String(cat.name || '').toLowerCase();
      const labels = cat.labels || [];
      for (const a of (cat.athletes || [])) {
        const who = (a.athlete || {}).displayName;
        const row = a.stats || [];
        if (type === 'passing') {
          add(who, 'pass_yd', pick(labels, 'YDS', row));
          add(who, 'pass_td', pick(labels, 'TD', row));
          add(who, 'pass_int', pick(labels, 'INT', row));
          add(who, 'pass_sack', num(String(row[labels.findIndex(l => String(l).toUpperCase() === 'SACKS')] || '').split('-')[0]));
          const ca = String(row[labels.findIndex(l => String(l).toUpperCase() === 'C/ATT')] || '').split('/');
          const cmp = num(ca[0]), att = num(ca[1]);
          add(who, 'pass_cmp', cmp);
          add(who, 'pass_att', att);
          add(who, 'pass_inc', Math.max(0, att - cmp));
        } else if (type === 'rushing') {
          add(who, 'rush_yd', pick(labels, 'YDS', row));
          add(who, 'rush_td', pick(labels, 'TD', row));
          add(who, 'rush_att', pick(labels, 'CAR', row));
        } else if (type === 'receiving') {
          add(who, 'rec', pick(labels, 'REC', row));
          add(who, 'rec_yd', pick(labels, 'YDS', row));
          add(who, 'rec_td', pick(labels, 'TD', row));
        } else if (type === 'fumbles') {
          add(who, 'fum', pick(labels, 'FUM', row));
          add(who, 'fum_lost', pick(labels, 'LOST', row));
          add(dstName, 'fum_rec', pick(labels, 'REC', row));
        } else if (type === 'kicking') {
          // "FG" comes through as made/attempted, e.g. 3/4
          const fg = String(row[labels.findIndex(l => String(l).toUpperCase() === 'FG')] || '');
          const made = num(fg.split('/')[0]);
          const longest = pick(labels, 'LONG', row);
          // Without per-kick distances, bucket by the longest make. Replace this
          // with play-by-play if your league is fussy about 50-yarders.
          const att = num(fg.split('/')[1]);
          if (made) {
            add(who, 'fgm', made);
            if (longest >= 50) { add(who, 'fgm_50p', 1); add(who, 'fgm_30_39', Math.max(0, made - 1)); }
            else if (longest >= 40) { add(who, 'fgm_40_49', 1); add(who, 'fgm_30_39', Math.max(0, made - 1)); }
            else add(who, 'fgm_30_39', made);
            add(who, 'fgm_yds', longest);
            if (longest > 30) add(who, 'fgm_yds_over_30', longest - 30);
          }
          add(who, 'fgmiss', Math.max(0, att - made));
          const xp = String(row[labels.findIndex(l => String(l).toUpperCase() === 'XP')] || '').split('/');
          add(who, 'xpm', num(xp[0]));
          add(who, 'xpmiss', Math.max(0, num(xp[1]) - num(xp[0])));
        } else if (type === 'defensive') {
          add(dstName, 'sack', pick(labels, 'SACKS', row));
          add(dstName, 'def_td', pick(labels, 'TD', row));
          add(dstName, 'qb_hit', pick(labels, 'QB HTS', row));
          add(dstName, 'tkl_solo', pick(labels, 'SOLO', row));
          add(dstName, 'tkl', pick(labels, 'TOT', row));
          add(dstName, 'tkl_loss', pick(labels, 'TFL', row));
          add(dstName, 'def_pass_def', pick(labels, 'PD', row));
        } else if (type === 'interceptions') {
          add(dstName, 'int', pick(labels, 'INT', row));
          add(dstName, 'int_ret_yd', pick(labels, 'YDS', row));
          add(dstName, 'def_td', pick(labels, 'TD', row));
        }
      }
    }
  }
}
