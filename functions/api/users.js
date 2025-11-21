import { jsonResponse, authenticateUser, updateUserBalance, hashPassword } from '../utils';

/**
 * HANDLE GET REQUEST (Mengambil data user, bank, statistik, referral, dan settings)
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
  
  if (user.role !== 'admin' && user.id.toString() !== id) {
      return jsonResponse({ error: 'Forbidden' }, 403);
  }

  try {
    // KRITIS: Ambil user TERBARU dari DB untuk mendapatkan semua kolom
    const currentUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!currentUser) return jsonResponse({ error: 'User not found' }, 404);
    
    // Ambil Plan Aktif
    const activePlan = await env.DB.prepare(`
      SELECT p.name, p.daily_jobs_limit, p.commission, s.end_date
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(id).first();

    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    
    // Ambil Statistik Hari Ini
    const stats = await env.DB.prepare(`
        SELECT 
            (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE user_id=? AND type IN ('income','commission', 'admin_add') AND created_at >= ? AND status='success') as income,
            (SELECT COUNT(*) FROM task_completions WHERE user_id=? AND completed_at >= ?) as tasks
    `).bind(id, todayStart, id, todayStart).first();
    
    // Ambil Global Settings (untuk ditampilkan di halaman Referral)
    const settingsRes = await env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'affiliate_l%' OR key LIKE 'rabat_l%' OR key = 'running_text'").all();
    const globalSettings = {};
    if (settingsRes.results) {
        settingsRes.results.forEach(s => globalSettings[s.key] = s.value);
    }
    
    // --- LOGIKA REFERRAL BERTINGKAT (L1, L2, L3) ---
    
    // L1: Downline langsung dari user
    const l1Res = await env.DB.prepare('SELECT id, username, created_at, referrer_id FROM users WHERE referrer_id = ? ORDER BY created_at DESC').bind(id).all();
    const l1 = l1Res.results;
    
    let l2 = [], l3 = [];
    
    if (l1.length > 0) {
        const l1Ids = l1.map(u => u.id);
        
        // L2: Downline dari L1
        const l2Res = await env.DB.prepare(`
            SELECT id, username, created_at, referrer_id FROM users WHERE referrer_id IN (${l1Ids.map(() => '?').join(',')}) ORDER BY created_at DESC
        `).bind(...l1Ids).all();
        
        l2 = l2Res.results;
        
        if (l2.length > 0) {
            const l2Ids = l2.map(u => u.id);
            // L3: Downline dari L2
            const l3Res = await env.DB.prepare(`
                SELECT id, username, created_at, referrer_id FROM users WHERE referrer_id IN (${l2Ids.map(() => '?').join(',')}) ORDER BY created_at DESC
            `).bind(...l2Ids).all();
            l3 = l3Res.results;
        }
    }
    
    // Format data user (menghilangkan password hash dan auth token untuk keamanan)
    const { password_hash, auth_token, ...safeUser } = currentUser;

    return jsonResponse({
      user: {
        ...safeUser,
        today_income: stats.income || 0,
        tasks_done: stats.tasks || 0,
      },
      plan: activePlan || null,
      bank_info: {
          bank_name: currentUser.bank_name,
          account_number: currentUser.account_number,
          account_name: currentUser.account_name,
      },
      // Mengirimkan data settings global juga
      settings: globalSettings,
      referrals: {
          l1: l1.map(u => ({ id: u.id, username: u.username, created_at: u.created_at })),
          l2: l2.map(u => ({ id: u.id, username: u.username, created_at: u.created_at, upline: l1.find(l => l.id === u.referrer_id)?.username || 'N/A' })),
          l3: l3.map(u => ({ id: u.id, username: u.username, created_at: u.created_at, upline: l2.find(l => l.id === u.referrer_id)?.username || 'N/A' })),
      }
    });

  } catch (e) {
    return jsonResponse({ error: 'Server Error: ' + e.message }, 500);
  }
}

/**
 * HANDLE POST REQUEST (Update Bank Info dan Change Password)
 */
export async function onRequestPost(context) {
    const { request, env } = context;
    const user = await authenticateUser(env, request);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    const body = await request.json();
    const { action } = body;
    const userId = user.id;

    try {
        if (action === 'update_bank') {
            const { bank_name, account_number, account_name } = body;
            
            if (!bank_name || !account_number || !account_name) {
                return jsonResponse({ error: 'Semua kolom bank wajib diisi.' }, 400);
            }

            await env.DB.prepare(`
                UPDATE users SET bank_name = ?, account_number = ?, account_name = ? WHERE id = ?
            `).bind(bank_name, account_number, account_name, userId).run();

            return jsonResponse({ success: true, message: 'Data bank berhasil disimpan.' });
        }
        
        if (action === 'change_pass') {
            const { old, new: newPass } = body;
            
            if (!old || !newPass || newPass.length < 6) {
                return jsonResponse({ error: 'Password baru minimal 6 karakter.' }, 400);
            }
            
            const hashedOld = await hashPassword(old);

            if (hashedOld !== user.password_hash) {
                return jsonResponse({ error: 'Password lama salah.' }, 400);
            }
            
            const hashedNew = await hashPassword(newPass);
            await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hashedNew, userId).run();

            return jsonResponse({ success: true, message: 'Password berhasil diubah.' });
        }

        return jsonResponse({ error: 'Invalid Action' }, 400);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}
