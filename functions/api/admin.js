import { jsonResponse, getYoutubeId, authenticateUser, hashPassword, updateUserBalance } from '../utils';

/**
 * KRITIS: Memverifikasi user adalah Admin sebelum menjalankan endpoint ini
 * @param {object} env
 * @param {Request} request
 * @returns {Promise<object|null>}
 */
const authenticateAdmin = async (env, request) => {
    const user = await authenticateUser(env, request);
    if (!user || user.role !== 'admin') return null;
    return user;
};


// --- GET HANDLERS ---
export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');
  const admin = await authenticateAdmin(env, request);
  if (!admin) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    if (type === 'stats') {
      const userCount = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first();
      // Total Deposit Sukses
      const depositSum = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'deposit' AND status = 'success'").first();
      // Total Withdrawal Sukses
      const withdrawSum = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE type = 'withdrawal' AND status = 'success'").first();
      // Total Pending (WD + Deposit)
      const pendingTotal = await env.DB.prepare("SELECT COALESCE(SUM(amount), 0) as total FROM transactions WHERE status = 'pending'").first();
      
      return jsonResponse({
        users: userCount.total || 0,
        deposit: depositSum.total || 0,
        withdraw: withdrawSum.total || 0,
        pending: pendingTotal.total || 0,
      });
    }
    
    if (type === 'users') {
      const page = parseInt(url.searchParams.get('page')) || 1;
      const limit = parseInt(url.searchParams.get('limit')) || 10;
      const q = url.searchParams.get('q') || '';
      const offset = (page - 1) * limit;

      let whereClause = '';
      if (q) whereClause = `WHERE username LIKE '%${q}%'`;

      // Mengambil semua kolom (termasuk balance yang sudah ada)
      const res = await env.DB.prepare(`
        SELECT id, username, email, status, role, balance, created_at 
        FROM users 
        ${whereClause}
        ORDER BY id DESC 
        LIMIT ? OFFSET ?
      `).bind(limit, offset).all();

      const totalCount = await env.DB.prepare(`SELECT COUNT(*) as total FROM users ${whereClause}`).first();
      
      return jsonResponse({
          data: res.results,
          pagination: {
              total_items: totalCount.total,
              total_pages: Math.ceil(totalCount.total / limit),
              current_page: page
          }
      });
    }

    if (type === 'pending_tx') {
       // Mengambil WD pending dan Deposit pending
       const res = await env.DB.prepare(`
         SELECT t.*, u.username 
         FROM transactions t
         JOIN users u ON t.user_id = u.id
         WHERE t.status = 'pending' 
         ORDER BY t.created_at DESC LIMIT 50
       `).all();
       return jsonResponse(res.results);
    }
    
    // Admin Info & CS Endpoints
    if (type === 'cs') {
        const res = await env.DB.prepare('SELECT * FROM cs_contacts ORDER BY platform, type').all();
        return jsonResponse(res.results);
    }
    if (type === 'info') {
        const res = await env.DB.prepare('SELECT id, title, created_at FROM informations ORDER BY created_at DESC').all();
        return jsonResponse(res.results);
    }

    if (type === 'settings') {
       const res = await env.DB.prepare('SELECT key, value FROM site_settings').all();
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

// --- POST HANDLERS (ADMIN ACTIONS) ---
export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { action } = body;
  const admin = await authenticateAdmin(env, request);
  if (!admin) return jsonResponse({ error: 'Unauthorized' }, 401);

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
        // Dapatkan durasi default dari plan ID yang dipilih (jika ada)
        const plan = await env.DB.prepare('SELECT watch_duration FROM plans WHERE id = ?').bind(min_plan).first();
        const duration = plan ? plan.watch_duration : 30;

        await env.DB.prepare('INSERT INTO jobs (title, youtube_url, duration, min_plan_level) VALUES (?, ?, ?, ?)').bind(title, cleanUrl, duration, min_plan).run();
        return jsonResponse({ success: true });
    }

    if (action === 'create_plan') {
        const { name, price, duration, daily_jobs, commission, return_capital, thumbnail, min_active_referrals, referral_percent, rabat_percent } = body;
        const watchDur = 30; 

        await env.DB.prepare(`
          INSERT INTO plans (name, price, duration_days, daily_jobs_limit, commission, return_capital, watch_duration, thumbnail_url, is_active, min_active_referrals, referral_percent, rabat_percent)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        `).bind(name, price, duration, daily_jobs, commission, return_capital ? 1 : 0, watchDur, thumbnail, min_active_referrals, referral_percent, rabat_percent).run();
        
        return jsonResponse({ success: true });
    }
    
    // --- CS & INFO MANAGEMENT ---
    if (action === 'create_cs') {
        const { platform, type, name, url } = body;
        await env.DB.prepare('INSERT INTO cs_contacts (platform, type, name, url) VALUES (?, ?, ?, ?)').bind(platform, type, name, url).run();
        return jsonResponse({ success: true });
    }
    if (action === 'delete_cs') {
        const { id } = body;
        await env.DB.prepare('DELETE FROM cs_contacts WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
    }
    if (action === 'create_info') {
        const { title, content } = body;
        await env.DB.prepare('INSERT INTO informations (title, content) VALUES (?, ?)').bind(title, content).run();
        return jsonResponse({ success: true });
    }
    if (action === 'delete_info') {
        const { id } = body;
        await env.DB.prepare('DELETE FROM informations WHERE id = ?').bind(id).run();
        return jsonResponse({ success: true });
    }

    // --- TRANSACTION PROCESSING ---
    if (action === 'process_tx') {
        const { tx_id, decision } = body; 
        const status = decision === 'approve' ? 'success' : 'failed';

        const tx = await env.DB.prepare('SELECT user_id, type, amount, status FROM transactions WHERE id = ?').bind(tx_id).first();
        if (!tx || tx.status !== 'pending') return jsonResponse({ error: 'Transaksi tidak valid atau sudah diproses.' }, 400);
        
        // 1. Update Status Transaksi
        await env.DB.prepare("UPDATE transactions SET status = ? WHERE id = ?").bind(status, tx_id).run();

        // 2. KRITIS: LOGIKA UPDATE SALDO
        if (decision === 'approve') {
            const amount = tx.amount;
            
            if (tx.type === 'deposit') {
                // Deposit disetujui: TAMBAH saldo user
                await updateUserBalance(env, tx.user_id, amount);
            } 
            // Jika WD disetujui, saldo sudah dikurangi saat pengajuan, jadi tidak ada perubahan lagi di sini.
        
        } else if (decision === 'reject') { 
             if (tx.type === 'withdrawal') {
                 // WD ditolak: KEMBALIKAN saldo user (saldo WD dikurangi saat pengajuan)
                 await updateUserBalance(env, tx.user_id, tx.amount); 
             }
        }

        return jsonResponse({ success: true });
    }

    // --- USER ACTIONS (Saldo, Password, Role, Ban) ---
    if (action === 'user_action') {
        const { user_id, type, value } = body; 
        
        if (type === 'adjust_balance') {
            const amount = parseFloat(value);
            if (isNaN(amount) || amount === 0) return jsonResponse({ error: 'Nominal tidak valid.' }, 400);

            const txType = amount > 0 ? 'admin_add' : 'admin_deduct';
            
            // 1. Catat Transaksi
            await env.DB.prepare(`
                INSERT INTO transactions (user_id, type, amount, description, status) 
                VALUES (?, ?, ?, 'Penyesuaian Admin', 'success')
            `).bind(user_id, txType, Math.abs(amount)).run();
            
            // 2. KRITIS: Update Saldo di kolom users.balance
            await updateUserBalance(env, user_id, amount);

        } else if (type === 'change_pass') {
            if(!value || value.length < 6) return jsonResponse({ error: 'Password minimal 6 karakter.' }, 400);
            const hashedPassword = await hashPassword(value);
            await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hashedPassword, user_id).run();
            
        } else if (type === 'set_role') {
            const role = value === 'admin' ? 'admin' : 'user';
            await env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(role, user_id).run();
            
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
