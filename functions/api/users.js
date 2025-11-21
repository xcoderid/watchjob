import { jsonResponse, authenticateUser, getUserBalance, hashPassword } from '../utils';

// HANDLE GET REQUEST (Ambil Data)
export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);
  
  // Validasi: User biasa hanya boleh lihat datanya sendiri
  if (user.role !== 'admin' && user.id.toString() !== id) {
      return jsonResponse({ error: 'Forbidden' }, 403);
  }

  try {
    // 1. Ambil Saldo Realtime
    const balance = await getUserBalance(env, id);
    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    
    // 2. Statistik Harian
    const stats = await env.DB.prepare(`
        SELECT 
            (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE user_id=? AND type IN ('income','commission') AND created_at >= ? AND status='success') as income,
            (SELECT COUNT(*) FROM task_completions WHERE user_id=? AND completed_at >= ?) as tasks
    `).bind(id, todayStart, id, todayStart).first();

    // 3. Data Referral (L1, L2, L3)
    const l1 = await env.DB.prepare('SELECT id, username, created_at FROM users WHERE referrer_id = ? ORDER BY created_at DESC').bind(id).all();
    let l2 = [], l3 = [];
    
    if (l1.results.length > 0) {
        const l1Ids = l1.results.map(u => u.id).join(',');
        // Get L2
        l2 = await env.DB.prepare(`
            SELECT u.id, u.username, u.created_at, upline.username as upline 
            FROM users u 
            JOIN users upline ON u.referrer_id = upline.id 
            WHERE u.referrer_id IN (${l1Ids}) ORDER BY u.created_at DESC
        `).all();

        if (l2.results.length > 0) {
            const l2Ids = l2.results.map(u => u.id).join(',');
            // Get L3
            l3 = await env.DB.prepare(`
                SELECT u.id, u.username, u.created_at, upline.username as upline 
                FROM users u 
                JOIN users upline ON u.referrer_id = upline.id 
                WHERE u.referrer_id IN (${l2Ids}) ORDER BY u.created_at DESC
            `).all();
        }
    }

    // 4. Ambil Plan Aktif
    const plan = await env.DB.prepare(`
      SELECT p.name, p.daily_jobs_limit, p.commission, s.end_date
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(id).first();

    // 5. Config Global
    const settings = await env.DB.prepare("SELECT value FROM site_settings WHERE key='running_text'").first();

    return jsonResponse({
        user: { ...user, today_income: stats.income || 0, tasks_done: stats.tasks || 0, balance },
        plan: plan || null,
        bank_info: { 
            bank_name: user.bank_name,
            account_number: user.account_number,
            account_name: user.account_name
        },
        referrals: {
            l1: l1.results,
            l2: l2.results || [],
            l3: l3.results || []
        },
        running_text: settings?.value || ''
    });

  } catch (e) { return jsonResponse({ error: e.message }, 500); }
}

// HANDLE POST REQUEST (Simpan Data - Bank & Password)
// Ini yang sebelumnya hilang sehingga menyebabkan Error 405
export async function onRequestPost(context) {
    const { request, env } = context;
    
    // Auth Check
    const user = await authenticateUser(env, request);
    if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

    let body;
    try { body = await request.json(); } catch(e) { return jsonResponse({ error: 'Bad Request' }, 400); }
    
    // ACTION: UPDATE BANK
    if (body.action === 'update_bank') {
        const { bank_name, account_number, account_name } = body;
        
        if (!bank_name || !account_number || !account_name) {
            return jsonResponse({ error: 'Semua kolom bank wajib diisi' }, 400);
        }

        try {
            await env.DB.prepare(`
                UPDATE users SET bank_name = ?, account_number = ?, account_name = ? WHERE id = ?
            `).bind(bank_name, account_number, account_name, user.id).run();
            
            return jsonResponse({ success: true, message: 'Data bank berhasil disimpan' });
        } catch (e) {
            return jsonResponse({ error: 'Database Error: ' + e.message }, 500);
        }
    }

    // ACTION: CHANGE PASSWORD
    if (body.action === 'change_pass') {
        const { old, new: newPass } = body;
        
        if (!newPass || newPass.length < 6) return jsonResponse({ error: 'Password baru minimal 6 karakter' }, 400);

        const hashedOld = await hashPassword(old);
        
        // Verifikasi password lama
        const verify = await env.DB.prepare('SELECT id FROM users WHERE id = ? AND password_hash = ?').bind(user.id, hashedOld).first();
        if (!verify) return jsonResponse({ error: 'Password lama salah' }, 400);

        const hashedNew = await hashPassword(newPass);
        await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hashedNew, user.id).run();
        
        return jsonResponse({ success: true, message: 'Password berhasil diubah' });
    }

    return jsonResponse({ error: 'Invalid Action' }, 400);
}
