import { jsonResponse, authenticateUser } from '../utils';

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

        // --- PERUBAHAN: MENGHAPUS PENGECEKAN DUPLIKAT JOB ID ---
        // User sekarang bebas menonton video yang sama berkali-kali
        
        // 3. Proses Transaksi
        const ops = [];
        const job = await env.DB.prepare('SELECT title FROM jobs WHERE id = ?').bind(job_id).first();
        
        // Catat penyelesaian tugas
        ops.push(env.DB.prepare(`INSERT INTO task_completions (user_id, job_id, amount_earned) VALUES (?, ?, ?)`).bind(user.id, job_id, sub.commission));
        // Catat pendapatan
        ops.push(env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'income', ?, ?, 'success')`).bind(user.id, sub.commission, `Reward: ${job?.title || 'Video'}`));

        // 4. Komisi Rabat Upline
        if (user.referrer_id && sub.id !== 1) {
            const upline = await env.DB.prepare(`
                SELECT p.rabat_percent, u.id 
                FROM users u
                JOIN user_subscriptions s ON u.id = s.user_id
                JOIN plans p ON s.plan_id = p.id
                WHERE u.id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
            `).bind(user.referrer_id).first();

            if (upline && upline.rabat_percent > 0) {
                const rabat = (sub.commission * upline.rabat_percent) / 100;
                if (rabat > 0) {
                    ops.push(env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')`).bind(upline.id, rabat, `Rabat Task dari Downline`));
                }
            }
        }

        await env.DB.batch(ops);
        return jsonResponse({ success: true, reward: sub.commission });

    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
  return jsonResponse({ error: 'Invalid action' }, 400);
}
