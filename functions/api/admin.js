import { jsonResponse, getYoutubeId } from '../utils';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  try {
    if (type === 'stats') {
      const users = await env.DB.prepare('SELECT COUNT(*) as t FROM users').first();
      const depo = await env.DB.prepare("SELECT SUM(amount) as t FROM transactions WHERE type = 'deposit' AND status = 'success'").first();
      return jsonResponse({ users: users.t, deposit: depo.t || 0 });
    }
    
    if (type === 'users') {
      const res = await env.DB.prepare(`SELECT id, username, email, balance, status, role FROM users ORDER BY id DESC LIMIT 100`).all();
      return jsonResponse(res.results);
    }

    if (type === 'settings') {
       const res = await env.DB.prepare('SELECT * FROM site_settings').all();
       const settings = {};
       // Fallback jika table settings kosong (menghindari error loop)
       if(res.results) res.results.forEach(r => settings[r.key] = r.value);
       return jsonResponse(settings);
    }

    return jsonResponse({ error: 'Unknown type' }, 400);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { action } = body;

  try {
    if (action === 'update_settings') {
        const { l1, l2, l3, running_text } = body;
        await env.DB.batch([
            env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('affiliate_l1', ?)").bind(l1),
            env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('affiliate_l2', ?)").bind(l2),
            env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('affiliate_l3', ?)").bind(l3),
            env.DB.prepare("INSERT OR REPLACE INTO site_settings (key, value) VALUES ('running_text', ?)").bind(running_text)
        ]);
        return jsonResponse({ success: true });
    }

    if (action === 'create_job') {
        const { title, url, min_plan } = body;
        const vidId = getYoutubeId(url); 
        const cleanUrl = `https://www.youtube.com/watch?v=${vidId}`;
        const plan = await env.DB.prepare('SELECT watch_duration FROM plans WHERE id = ?').bind(min_plan).first();
        
        await env.DB.prepare('INSERT INTO jobs (title, youtube_url, duration, min_plan_level) VALUES (?, ?, ?, ?)').bind(title, cleanUrl, plan?.watch_duration || 30, min_plan).run();
        return jsonResponse({ success: true });
    }
    
    return jsonResponse({ error: 'Invalid Action' }, 400);
  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
