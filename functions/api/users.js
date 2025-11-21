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
    // Ambil user TERBARU dari DB untuk mendapatkan semua kolom baru
    const currentUser = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    if (!currentUser) return jsonResponse({ error: 'User not found' }, 404);
    
    // Menambahkan 'p.id' agar Frontend bisa membaca ID Plan saat ini
    const activePlan = await env.DB.prepare(`
      SELECT p.id, p.name, p.daily_jobs_limit, p.commission, s.end_date
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(id).first();

    // Tambah 7 jam manual agar tanggalnya berganti pas jam 00.00 WIB.
    // 1. Ambil waktu server saat ini (UTC)
    const now = new Date();
    
    // 2. Pura-pura jadi WIB (Tambah 7 Jam) untuk menentukan "ini tanggal berapa di Indo?"
    const wibOffset = 7 * 60 * 60 * 1000;
    const wibDate = new Date(now.getTime() + wibOffset);
    
    // 3. Reset jamnya menjadi 00:00:00 (Awal Hari WIB)
    wibDate.setUTCHours(0, 0, 0, 0);
    
    // 4. Kembalikan ke UTC agar cocok dengan data di Database D1
    // (00:00 WIB = 17:00 UTC hari kemarin)
    const dbQueryDate = new Date(wibDate.getTime() - wibOffset);
    
    // 5. Jadikan String SQL (YYYY-MM-DD HH:MM:SS)
    const todayStart = dbQueryDate.toISOString().replace('T', ' ').split('.')[0];
    // --------------------------------------------
    
    // Ambil Statistik Hari Ini
    const stats = await env.DB.prepare(`
        SELECT 
            (SELECT COALESCE(SUM(amount),0) FROM transactions WHERE user_id=? AND type IN ('income','commission', 'admin_add') AND created_at >= ? AND status='success') as income,
            (SELECT COUNT(*) FROM task_completions WHERE user_id=? AND completed_at >= ?) as tasks
    `).bind(id, todayStart, id, todayStart).first();

    // --- TAMBAHAN AMAN (TRY CATCH): Ambil Data Settings ---
    // Menggunakan "key" dengan kutip karena key adalah reserved word di SQL
    let settings = {};
    try {
        const settingsRaw = await env.DB.prepare('SELECT "key", "value" FROM site_settings').all();
        if (settingsRaw && settingsRaw.results) {
            settingsRaw.results.forEach(item => {
                settings[item.key] = item.value;
            });
        }
    } catch (err) {
        // Jika tabel belum ada atau query gagal, biarkan settings kosong agar APP TIDAK CRASH (500)
        console.error("Gagal load settings:", err.message);
    }

    // Ambil Data Referral (L1, L2, L3)
    const l1 = await env.DB.prepare('SELECT id, username, created_at FROM users WHERE referrer_id = ? ORDER BY created_at DESC').bind(id).all();
    let l2 = [], l3 = [];
    
    if (l1.results.length > 0) {
        const l1Ids = l1.results.map(u => u.id);
        
        const l2Res = await env.DB.prepare(`
            SELECT id, username, referrer_id, created_at FROM users WHERE referrer_id IN (${l1Ids.map(() => '?').join(',')}) ORDER BY created_at DESC
        `).bind(...l1Ids).all();
        
        l2 = l2Res.results;
        
        if (l2.length > 0) {
            const l2Ids = l2.map(u => u.id);
            const l3Res = await env.DB.prepare(`
                SELECT id, username, referrer_id, created_at FROM users WHERE referrer_id IN (${l2Ids.map(() => '?').join(',')}) ORDER BY created_at DESC
            `).bind(...l2Ids).all();
            l3 = l3Res.results;
        }
    }
    
    // Format data user
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
      referrals: {
          l1: l1.results.map(u => ({ id: u.id, username: u.username, created_at: u.created_at })),
          l2: l2.map(u => ({ id: u.id, username: u.username, created_at: u.created_at, upline: l1.results.find(l => l.id === u.referrer_id)?.username || 'N/A' })),
          l3: l3.map(u => ({ id: u.id, username: u.username, created_at: u.created_at, upline: l2.find(l => l.id === u.referrer_id)?.username || 'N/A' })),
      },
      settings: settings // --- Settings dikirim (kosong jika error, tapi tidak bikin crash) ---
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
            if (!bank_name || !account_number || !account_name) return jsonResponse({ error: 'Semua kolom bank wajib diisi.' }, 400);

            await env.DB.prepare(`UPDATE users SET bank_name = ?, account_number = ?, account_name = ? WHERE id = ?`)
                .bind(bank_name, account_number, account_name, userId).run();

            return jsonResponse({ success: true, message: 'Data bank berhasil disimpan.' });
        }
        
        if (action === 'change_pass') {
            const { old, new: newPass } = body;
            if (!old || !newPass || newPass.length < 6) return jsonResponse({ error: 'Password baru minimal 6 karakter.' }, 400);
            
            const hashedOld = await hashPassword(old);
            if (hashedOld !== user.password_hash) return jsonResponse({ error: 'Password lama salah.' }, 400);
            
            const hashedNew = await hashPassword(newPass);
            await env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hashedNew, userId).run();

            return jsonResponse({ success: true, message: 'Password berhasil diubah.' });
        }

        return jsonResponse({ error: 'Invalid Action' }, 400);
    } catch (e) {
        return jsonResponse({ error: e.message }, 500);
    }
}
