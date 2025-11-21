import { jsonResponse, authenticateUser, updateUserBalance } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    // 1. Cek Paket Aktif
    const sub = await env.DB.prepare(`
      SELECT p.id, p.commission, p.daily_jobs_limit, s.end_date
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user.id).first();

    if (!sub) {
        return jsonResponse({
            success: true,
            message: "Paket kedaluwarsa.",
            daily_limit: 0,
            tasks_done: 0,
            user_commission: 0,
            jobs: []
        });
    }

    // 2. Ambil Semua Job (Acak)
    const jobs = await env.DB.prepare(`SELECT id, title, youtube_url, duration FROM jobs ORDER BY RANDOM() LIMIT 20`).all();

    // 3. Hitung Tugas Hari Ini
    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    const taskCount = await env.DB.prepare(`
      SELECT COUNT(*) as total FROM task_completions 
      WHERE user_id = ? AND completed_at >= ?
    `).bind(user.id, todayStart).first();

    return jsonResponse({
      success: true,
      daily_limit: sub.daily_jobs_limit,
      tasks_done: taskCount.total,
      user_commission: sub.commission,
      jobs: jobs.results
    });

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { action, job_id } = await request.json(); 

  if (action === 'claim') {
    try {
        // 1. Validasi Paket
        const sub = await env.DB.prepare(`
          SELECT p.id, p.name, p.commission, p.daily_jobs_limit 
          FROM user_subscriptions s
          JOIN plans p ON s.plan_id = p.id
          WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
        `).bind(user.id).first();

        if (!sub) return jsonResponse({ error: 'Paket tidak aktif.' }, 403);

        // 2. Cek Limit Harian (Global Count)
        const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
        const doneCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM task_completions WHERE user_id = ? AND completed_at >= ?`).bind(user.id, todayStart).first();

        if (doneCount.count >= sub.daily_jobs_limit) {
            return jsonResponse({ error: 'Kuota harian paket Anda sudah habis.' }, 403);
        }

        const commission = sub.commission;
        const ops = [];
        const job = await env.DB.prepare('SELECT title FROM jobs WHERE id = ?').bind(job_id).first();
        
        // Catat penyelesaian tugas
        ops.push(env.DB.prepare(`INSERT INTO task_completions (user_id, job_id, amount_earned) VALUES (?, ?, ?)`).bind(user.id, job_id, commission));
        
        // Catat pendapatan & update saldo user
        ops.push(env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'income', ?, ?, 'success')`).bind(user.id, commission, `Reward: ${job?.title || 'Video'}`));
        await updateUserBalance(env, user.id, commission); // KRITIS: Update Saldo User

        // 4. LOGIKA RABAT (Komisi Upline dari Tugas Downline) - MENGGUNAKAN SETTINGS GLOBAL
        if (user.referrer_id && sub.id !== 1) { // Downline bukan Trial
            const settingsRes = await env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'rabat_l%'").all();
            const rates = {}; 
            if(settingsRes.results) { 
                settingsRes.results.forEach(s => rates[s.key] = parseFloat(s.value));
            }
            
            // Fungsi untuk memproses rabat berjenjang (L1, L2, L3)
            const processRabat = async (level, downlineUser) => {
                const rateKey = `rabat_l${level}`;
                const rate = rates[rateKey] || 0;
                
                if (rate === 0 || !downlineUser.referrer_id) return;

                const upline = await env.DB.prepare('SELECT id, referrer_id, username FROM users WHERE id = ?').bind(downlineUser.referrer_id).first();
                if (!upline) return;
                
                const uplinePlan = await env.DB.prepare(`
                   SELECT p.price as upline_plan_price 
                   FROM user_subscriptions s JOIN plans p ON s.plan_id = p.id 
                   WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
                `).bind(upline.id).first();

                // Rabat hanya diberikan jika Upline punya paket aktif (untuk capping)
                if (uplinePlan) {
                    let rabatAmount = (commission * rate) / 100;
                    
                    // Capping rabat tugas: Maksimal rabat tidak boleh melebihi harga paket Upline
                    if (rabatAmount > uplinePlan.upline_plan_price) { rabatAmount = uplinePlan.upline_plan_price; }

                    if (rabatAmount > 0) {
                        ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(upline.id, rabatAmount, `Rabat L${level} dari ${user.username} (Task)`));
                        await updateUserBalance(env, upline.id, rabatAmount); // KRITIS: Update Saldo Upline
                    }
                    
                    // Lanjutkan ke level berikutnya
                    if (level < 3) {
                        await processRabat(level + 1, upline);
                    }
                }
            };
            
            // Mulai proses Rabat dari level 1 (dengan downline saat ini)
            await processRabat(1, user);
        }

        await env.DB.batch(ops);
        return jsonResponse({ success: true, reward: commission });

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
  return jsonResponse({ error: 'Invalid action' }, 400);
}
