/**
 * Front Office — league state, on Netlify
 *
 *   GET  /league/:id   ->  { rev, state }
 *   PUT  /league/:id   ->  { rev }  |  409 { rev, state }
 *
 * The whole league is one JSON document, which is exactly what a blob store is
 * for — no schema, no table to create, nothing to provision.
 */

import { getStore } from '@netlify/blobs';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,PUT,OPTIONS',
  'access-control-allow-headers': 'content-type,x-league-key',
  'access-control-max-age': '86400'
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS }
  });

export default async (req, context) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const id = String(context.params?.id || '').trim();
  if (!id || id.length > 80) return json({ error: 'bad league code' }, 400);

  const password = process.env.LEAGUE_KEY;
  if (password && req.headers.get('x-league-key') !== password)
    return json({ error: 'wrong league password' }, 401);

  // Strong consistency matters: the revision check reads before it writes, and
  // an eventually-consistent read would let a stale number through.
  const store = getStore({ name: 'leagues', consistency: 'strong' });

  try {
    if (req.method === 'GET') {
      const rec = await store.get(id, { type: 'json' });
      return json(rec ? { rev: rec.rev, state: rec.state } : { rev: 0, state: null });
    }

    if (req.method === 'PUT') {
      const body = await req.json().catch(() => null);
      if (!body || typeof body.state !== 'object' || body.state === null)
        return json({ error: 'send { rev, state }' }, 400);

      const text = JSON.stringify(body.state);
      if (text.length > 4_000_000) return json({ error: 'league is too large to store' }, 413);

      const current = await store.get(id, { type: 'json' });
      const currentRev = current ? Number(current.rev) || 0 : 0;
      const sent = Number(body.rev) || 0;

      // Your push only lands if nobody moved since you last read.
      if (current && sent !== currentRev)
        return json({ error: 'out of date', rev: currentRev, state: current.state }, 409);

      const next = currentRev + 1;
      await store.setJSON(id, { rev: next, state: body.state, updated: Date.now() });
      return json({ rev: next });
    }

    return json({ error: 'method not allowed' }, 405);
  } catch (e) {
    return json({ error: String(e?.message || e) }, 500);
  }
};

export const config = { path: '/league/:id' };
