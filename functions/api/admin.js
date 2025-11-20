import { jsonResponse, getYoutubeId, getUserBalance } from '../utils';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  try {
    if (type === 'stats') {
      const userCount = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first();
      const depositSum = await env.DB.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'deposit' AND status = 'success'").first();
      const pendingWd = await env.DB.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'withdrawal' AND status = 'pending'").first();
      
      return jsonResponse({
        users: userCount.total || 0,
        deposit: depositSum.total || 0,
        pending_wd: pendingWd.total || 0
      });
    }
    
    if (type === 'users') {
      const res = await env.DB.prepare(`
        SELECT id, username, email, status, role, created_at 
        FROM users 
        ORDER BY id DESC 
        LIMIT 50
      `).all();
      
      const usersWithBalance = [];
      for (const u of res.results) {
          const bal = await getUserBalance(env, u.id);
          usersWithBalance.push({ ...u, balance: bal });
      }
      
      return jsonResponse(usersWithBalance);
    }

    if (type === 'transactions') {
       const res = await env.DB.prepare("SELECT * FROM transactions WHERE type IN ('deposit', 'withdrawal') ORDER BY created_at DESC LIMIT 50").all();
       return jsonResponse(res.results);
    }

    if (type === 'settings') {
       const res = await env.DB.prepare('SELECT * FROM site_settings').all();
       const settings = {};
       if(res.results) {
           res.results.forEach(r => settings[r.key] = r.value);
       }
       return jsonResponse(settings);
    }

    if (type === 'plans') {
        const plans = await env.DB.prepare('SELECT * FROM plans').all();
        return jsonResponse(plans.results);
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
        if (!vidId) return jsonResponse({ error: 'URL Youtube tidak valid' }, 400);

        const cleanUrl = `https://www.youtube.com/watch?v=${vidId}`;
        const plan = await env.DB.prepare('SELECT watch_duration FROM plans WHERE id = ?').bind(min_plan).first();
        const duration = plan ? plan.watch_duration : 30;

        await env.DB.prepare('INSERT INTO jobs (title, youtube_url, duration, min_plan_level) VALUES (?, ?, ?, ?)').bind(title, cleanUrl, duration, min_plan).run();
        return jsonResponse({ success: true });
    }

    if (action === 'create_plan') {
        const { name, price, duration, daily_jobs, commission, return_capital, thumbnail } = body;
        const watchDur = 30; 

        await env.DB.prepare(`
          INSERT INTO plans (name, price, duration_days, daily_jobs_limit, commission, return_capital, watch_duration, thumbnail_url, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).bind(name, price, duration, daily_jobs, commission, return_capital ? 1 : 0, watchDur, thumbnail).run();
        
        return jsonResponse({ success: true });
    }

    if (action === 'process_wd') {
        const { tx_id, decision } = body; 
        const status = decision === 'approve' ? 'success' : 'failed';
        await env.DB.prepare("UPDATE transactions SET status = ? WHERE id = ?").bind(status, tx_id).run();
        return jsonResponse({ success: true });
    }

    if (action === 'user_action') {
        const { user_id, type, new_pass } = body; 
        
        if (type === 'reset_pass') {
            if(!new_pass) return jsonResponse({ error: 'Password baru diperlukan' }, 400);
            await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(new_pass, user_id).run();
        } else if (type === 'ban' || type === 'unban') {
            const status = type === 'ban' ? 'banned' : 'active';
            await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
        }
        return jsonResponse({ success: true });
    }
    
    return jsonResponse({ error: 'Invalid Action' }, 400);

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
