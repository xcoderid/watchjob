import { jsonResponse, authenticateUser, getYoutubeId, getUserBalance, hashPassword } from '../utils';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  const user = await authenticateUser(env, request);
  if (!user || user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);

  try {
    // --- DASHBOARD STATS ---
    if (type === 'stats') {
      const userCount = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first();
      const depositSum = await env.DB.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'deposit' AND status = 'success'").first();
      const wdSum = await env.DB.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'withdrawal' AND status = 'success'").first();
      const pendingTx = await env.DB.prepare("SELECT COUNT(*) as total FROM transactions WHERE status = 'pending'").first();
      
      return jsonResponse({
        users: userCount.total || 0,
        deposit: depositSum.total || 0,
        withdraw: wdSum.total || 0,
        pending: pendingTx.total || 0
      });
    }
    
    // --- USERS LIST ---
    if (type === 'users') {
        const page = parseInt(url.searchParams.get('page') || '1');
        const limit = parseInt(url.searchParams.get('limit') || '10');
        const search = url.searchParams.get('q') || '';
        const offset = (page - 1) * limit;

        let query = `SELECT id, username, email, status, role, created_at FROM users`;
        let countQuery = `SELECT COUNT(*) as total FROM users`;
        let params = [];

        if (search) {
            const whereClause = ` WHERE username LIKE ? OR email LIKE ?`; 
            query += whereClause;
            countQuery += whereClause;
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
        params.push(limit, offset);

        const [rows, countRes] = await Promise.all([
            env.DB.prepare(query).bind(...params).all(),
            env.DB.prepare(countQuery).bind(...(search ? [`%${search}%`, `%${search}%`] : [])).first()
        ]);

        const usersWithBalance = await Promise.all(rows.results.map(async u => ({ ...u, balance: await getUserBalance(env, u.id) })));

        return jsonResponse({
            data: usersWithBalance,
            pagination: {
                total: countRes.total,
                page: page,
                limit: limit,
                total_pages: Math.ceil(countRes.total / limit)
            }
        });
    }

    // --- OTHER GET TYPES ---
    if (type === 'pending_tx') {
       const res = await env.DB.prepare(`SELECT t.*, u.username FROM transactions t JOIN users u ON t.user_id = u.id WHERE t.status = 'pending' ORDER BY t.created_at ASC`).all();
       return jsonResponse(res.results);
    }
    if (type === 'settings') {
       const res = await env.DB.prepare('SELECT * FROM site_settings').all();
       const settings = {}; if(res.results) res.results.forEach(r => settings[r.key] = r.value);
       return jsonResponse(settings);
    }
    if (type === 'plans') {
        const plans = await env.DB.prepare('SELECT * FROM plans').all();
        return jsonResponse(plans.results);
    }
    if (type === 'cs') {
        const res = await env.DB.prepare('SELECT * FROM cs_contacts ORDER BY platform, type').all();
        return jsonResponse(res.results);
    }
    if (type === 'info') {
        const res = await env.DB.prepare('SELECT * FROM informations ORDER BY created_at DESC').all();
        return jsonResponse(res.results);
    }

    return jsonResponse({ error: 'Unknown type' }, 400);

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = await authenticateUser(env, request);
  if (!user || user.role !== 'admin') return jsonResponse({ error: 'Forbidden' }, 403);

  const body = await request.json();
  const { action } = body;

  try {
    if (action === 'user_action') {
        const { user_id, type, value } = body; 
        if (type === 'ban' || type === 'unban') {
            const status = type === 'ban' ? 'banned' : 'active';
            await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
        } else if (type === 'set_role') {
            await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(value, user_id).run();
        } else if (type === 'change_pass') {
            if(!value || value.length < 6) return jsonResponse({error:'Password min 6 char'}, 400);
            const hashed = await hashPassword(value);
            await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hashed, user_id).run();
        } else if (type === 'adjust_balance') {
            const amount = parseFloat(value);
            if (amount === 0) return jsonResponse({error:'Jumlah tidak boleh 0'}, 400);
            const typeTx = amount > 0 ? 'admin_add' : 'admin_deduct';
            await env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, ?, ?, 'Penyesuaian Admin', 'success')`).bind(user_id, typeTx, Math.abs(amount)).run();
        }
        return jsonResponse({ success: true });
    }

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
        const duration = plan ? plan.watch_duration : 30;
        await env.DB.prepare('INSERT INTO jobs (title, youtube_url, duration, min_plan_level) VALUES (?, ?, ?, ?)').bind(title, cleanUrl, duration, min_plan).run();
        return jsonResponse({ success: true });
    }
    
    if (action === 'create_plan') {
        const { name, price, duration, daily_jobs, commission, return_capital, thumbnail, min_active_referrals, referral_percent, rabat_percent } = body;
        await env.DB.prepare(`INSERT INTO plans (name, price, duration_days, daily_jobs_limit, commission, return_capital, watch_duration, thumbnail_url, is_active, min_active_referrals, referral_percent, rabat_percent) VALUES (?, ?, ?, ?, ?, ?, 30, ?, 1, ?, ?, ?)`).bind(name, price, duration, daily_jobs, commission, return_capital ? 1 : 0, thumbnail, min_active_referrals || 0, referral_percent || 0, rabat_percent || 0).run();
        return jsonResponse({ success: true });
    }
    
    if (action === 'process_tx') {
        const { tx_id, decision } = body; 
        const status = decision === 'approve' ? 'success' : 'failed';
        await env.DB.prepare("UPDATE transactions SET status = ? WHERE id = ?").bind(status, tx_id).run();
        return jsonResponse({ success: true });
    }

    if (action === 'create_cs') {
        const { platform, type, name, url } = body;
        await env.DB.prepare('INSERT INTO cs_contacts (platform, type, name, url) VALUES (?, ?, ?, ?)').bind(platform, type, name, url).run();
        return jsonResponse({ success: true });
    }
    if (action === 'delete_cs') {
        await env.DB.prepare('DELETE FROM cs_contacts WHERE id = ?').bind(body.id).run();
        return jsonResponse({ success: true });
    }
    if (action === 'create_info') {
        const { title, content } = body;
        await env.DB.prepare('INSERT INTO informations (title, content) VALUES (?, ?)').bind(title, content).run();
        return jsonResponse({ success: true });
    }
    if (action === 'delete_info') {
        await env.DB.prepare('DELETE FROM informations WHERE id = ?').bind(body.id).run();
        return jsonResponse({ success: true });
    }
    
    return jsonResponse({ error: 'Invalid Action' }, 400);

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
