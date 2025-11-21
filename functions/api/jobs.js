import { jsonResponse, authenticateUser, updateUserBalance } from '../utils';

// --- HANDLE GET: MENAMPILKAN DAFTAR MISI & STATUS KUOTA ---
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

    // 2. Ambil Job Random
    const jobs = await env.DB.prepare(`SELECT id, title, youtube_url, duration FROM jobs ORDER BY RANDOM() LIMIT 20`).all();

    // 3. HITUNG KUOTA HARI INI (FIX TIMEZONE WIB / UTC+7)
    // Agar reset tepat jam 00:00 WIB
    const now = new Date();
    const wibOffset = 7 * 60 * 60 * 1000; // Offset 7 Jam
    const wibDate = new Date(now.getTime() + wibOffset);
    wibDate.setUTCHours(0, 0, 0, 0); // Reset ke jam 00:00 WIB
    
    // Kembalikan ke UTC untuk query database
    const dbQueryDate = new Date(wibDate.getTime() - wibOffset);
    const todayStart = dbQueryDate.toISOString().replace('T', ' ').split('.')[0];

    // Hitung berapa tugas yang sudah selesai sejak jam 00:00 WIB tadi
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

// --- HANDLE POST: KLAIM REWARD SETELAH NONTON ---
export async function onRequestPost(context) {
  const { request, env } = context;
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { action, job_id } = await request.json(); 

  if (action === 'claim') {
    try {
        // 1. Validasi Paket Lagi
        const sub = await env.DB.prepare(`
          SELECT p.id, p.name, p.commission, p.daily_jobs_limit 
          FROM user_subscriptions s
          JOIN plans p ON s.plan_id = p.id
          WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
        `).bind(user.id).first();

        if (!sub) return jsonResponse({ error: 'Paket tidak aktif.' }, 403);

        // 2. Cek Limit Harian (FIX TIMEZONE WIB DISINI JUGA PENTING)
        // Agar user tidak bisa klaim lebih dari batas walaupun di frontend lolos
        const now = new Date();
        const wibOffset = 7 * 60 * 60 * 1000;
        const wibDate = new Date(now.getTime() + wibOffset);
        wibDate.setUTCHours(0, 0, 0, 0); 
        const dbQueryDate = new Date(wibDate.getTime() - wibOffset);
        const todayStart = dbQueryDate.toISOString().replace('T', ' ').split('.')[0];

        const doneCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM task_completions WHERE user_id = ? AND completed_at >= ?`).bind(user.id, todayStart).first();

        if (doneCount.count >= sub.daily_jobs_limit) {
            return jsonResponse({ error: 'Kuota harian paket Anda sudah habis. Besok reset jam 00:00 WIB.' }, 403);
        }

        const commission = sub.commission;
        const ops = [];
        const job = await env.DB.prepare('SELECT title FROM jobs WHERE id = ?').bind(job_id).first();
        
        // 3. Catat Transaksi
        ops.push(env.DB.prepare(`INSERT INTO task_completions (user_id, job_id, amount_earned) VALUES (?, ?, ?)`).bind(user.id, job_id, commission));
        ops.push(env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'income', ?, ?, 'success')`).bind(user.id, commission, `Reward: ${job?.title || 'Video'}`));
        await updateUserBalance(env, user.id, commission); 

        // 4. LOGIKA RABAT / KOMISI UPLINE (Aman dari error)
        if (user.referrer_id && sub.id !== 1) { 
            try {
                // Ambil settings persentase rabat
                const settingsRes = await env.DB.prepare('SELECT * FROM site_settings').all();
                const rates = {}; 
                if(settingsRes.results) { settingsRes.results.forEach(s => rates[s.key] = parseFloat(s.value)); }
                
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

                    if (uplinePlan) {
                        let rabatAmount = (commission * rate) / 100;
                        // Capping (Rabat tidak boleh lebih besar dari harga paket upline)
                        if (rabatAmount > uplinePlan.upline_plan_price) { rabatAmount = uplinePlan.upline_plan_price; }

                        if (rabatAmount > 0) {
                            ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(upline.id, rabatAmount, `Rabat L${level} dari ${user.username} (Task)`));
                            await updateUserBalance(env, upline.id, rabatAmount);
                        }
                        // Lanjut ke level atasnya
                        if (level < 3) { await processRabat(level + 1, upline); }
                    }
                };
                await processRabat(1, user);
            } catch(err) { console.error("Rabat error:", err); }
        }

        await env.DB.batch(ops);
        return jsonResponse({ success: true, reward: commission });

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
  return jsonResponse({ error: 'Invalid action' }, 400);
}
