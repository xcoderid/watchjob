import { jsonResponse, getYoutubeId } from '../utils';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  if (type === 'stats') {
    const users = await env.DB.prepare('SELECT COUNT(*) as t FROM users').first();
    const depo = await env.DB.prepare("SELECT SUM(amount) as t FROM transactions WHERE type = 'deposit' AND status = 'success'").first();
    const wd = await env.DB.prepare("SELECT SUM(amount) as t FROM transactions WHERE type = 'withdrawal' AND status = 'pending'").first();
    return jsonResponse({ users: users.t, deposit: depo.t || 0, pending_wd: wd.t || 0 });
  }
  
  if (type === 'users') {
    const res = await env.DB.prepare(`SELECT id, username, email, balance, status, role FROM users ORDER BY id DESC LIMIT 100`).all();
    return jsonResponse(res.results);
  }

  if (type === 'settings') {
     const res = await env.DB.prepare('SELECT * FROM site_settings').all();
     const settings = {};
     res.results.forEach(r => settings[r.key] = r.value);
     return jsonResponse(settings);
  }

  if (type === 'transactions') {
      const res = await env.DB.prepare("SELECT * FROM transactions WHERE type IN ('deposit','withdrawal') ORDER BY created_at DESC LIMIT 50").all();
      return jsonResponse(res.results);
  }
  
  return jsonResponse({ error: 'Unknown type' }, 400);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { action } = body;

  if (action === 'update_settings') {
      const { l1, l2, l3, running_text } = body;
      await env.DB.batch([
          env.DB.prepare("UPDATE site_settings SET value = ? WHERE key = 'affiliate_l1'").bind(l1),
          env.DB.prepare("UPDATE site_settings SET value = ? WHERE key = 'affiliate_l2'").bind(l2),
          env.DB.prepare("UPDATE site_settings SET value = ? WHERE key = 'affiliate_l3'").bind(l3),
          env.DB.prepare("UPDATE site_settings SET value = ? WHERE key = 'running_text'").bind(running_text)
      ]);
      return jsonResponse({ success: true });
  }

  if (action === 'user_action') {
      const { user_id, type, new_pass } = body; // type: ban, unban, reset_pass
      if (type === 'reset_pass') {
          await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(new_pass, user_id).run();
      } else {
          const status = type === 'ban' ? 'banned' : 'active';
          await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
      }
      return jsonResponse({ success: true });
  }

  if (action === 'create_job') {
      const { title, url, min_plan } = body;
      const vidId = getYoutubeId(url); // Gunakan helper untuk ekstrak ID dari URL apapun
      const cleanUrl = `https://www.youtube.com/watch?v=${vidId}`;
      // Ambil durasi tonton default dari Plan ID 1 atau inputan (disini pakai default plan jika mau)
      const plan = await env.DB.prepare('SELECT watch_duration FROM plans WHERE id = ?').bind(min_plan).first();
      await env.DB.prepare('INSERT INTO jobs (title, youtube_url, duration, min_plan_level) VALUES (?, ?, ?, ?)').bind(title, cleanUrl, plan?.watch_duration || 30, min_plan).run();
      return jsonResponse({ success: true });
  }

  if (action === 'create_plan') {
      const { name, price, duration, limit, comm, return_cap, watch_dur, thumb } = body;
      await env.DB.prepare(`
        INSERT INTO plans (name, price, duration_days, daily_jobs_limit, commission, return_capital, watch_duration, thumbnail_url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(name, price, duration, limit, comm, return_cap ? 1 : 0, watch_dur, thumb).run();
      return jsonResponse({ success: true });
  }
  
  if (action === 'process_wd') {
      const { tx_id, decision } = body; // decision: approve/reject
      const tx = await env.DB.prepare('SELECT * FROM transactions WHERE id = ?').bind(tx_id).first();
      if(tx.status !== 'pending') return jsonResponse({error:'Bukan transaksi pending'}, 400);
      
      if (decision === 'approve') {
          await env.DB.prepare("UPDATE transactions SET status = 'success' WHERE id = ?").bind(tx_id).run();
      } else {
          // Refund saldo
          await env.DB.batch([
              env.DB.prepare("UPDATE transactions SET status = 'failed' WHERE id = ?").bind(tx_id),
              env.DB.prepare("UPDATE users SET balance = balance + ? WHERE id = ?").bind(tx.amount, tx.user_id)
          ]);
      }
      return jsonResponse({ success: true });
  }

  return jsonResponse({ error: 'Invalid Action' }, 400);
}
