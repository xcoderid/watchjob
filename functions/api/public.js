import { jsonResponse } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  try {
    // Get CS Data
    if (type === 'cs') {
        const res = await env.DB.prepare('SELECT * FROM cs_contacts ORDER BY platform, type').all();
        return jsonResponse(res.results);
    }

    // Get Info List
    if (type === 'info') {
        const res = await env.DB.prepare('SELECT id, title, created_at, content FROM informations ORDER BY created_at DESC').all();
        return jsonResponse(res.results);
    }

    // Get Single Info (Detail)
    if (type === 'info_detail') {
        const id = url.searchParams.get('id');
        const res = await env.DB.prepare('SELECT * FROM informations WHERE id = ?').bind(id).first();
        if(!res) return jsonResponse({error:'Not Found'}, 404);
        return jsonResponse(res);
    }

    return jsonResponse({ error: 'Invalid type' }, 400);

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
