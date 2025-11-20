import { jsonResponse } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');

  if (!userId) return jsonResponse({ error: 'User ID required' }, 400);

  try {
    // 1. Cek Plan User untuk menentukan Level & Komisi
    const sub = await env.DB.prepare(`
      SELECT p.id, p.commission
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(userId).first();

    // Fallback ke Trial (Plan ID 1) jika tidak ada sub aktif
    let planId = sub ? sub.id : 1;
    let commission = sub ? sub.commission : 0;

    if (!sub) {
        const trial = await env.DB.prepare('SELECT id, commission FROM plans WHERE id = 1').first();
        if(trial) { planId = trial.id; commission = trial.commission; }
    }

    // 2. Ambil Jobs (Filter berdasarkan min_plan_level)
    const jobs = await env.DB.prepare(`
      SELECT * FROM jobs WHERE min_plan_level <= ? ORDER BY created_at DESC
    `).bind(planId).all();

    // 3. Cek Job yang sudah selesai hari ini
    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    const completed = await env.DB.prepare(`
      SELECT job_id FROM task_completions 
      WHERE user_id = ? AND completed_at >= ?
    `).bind(userId, todayStart).all();
    
    const completedIds = completed.results.map(row => row.job_id);

    return jsonResponse({
      jobs: jobs.results,
      completed_ids: completedIds,
      user_commission: commission
    });

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { action, user_id, job_id } = body; 

  if (action === 'claim') {
    try {
        // 1. Ambil Info Limit & Komisi dari Plan User
        const sub = await env.DB.prepare(`
          SELECT p.commission, p.daily_jobs_limit 
          FROM user_subscriptions s
          JOIN plans p ON s.plan_id = p.id
          WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
        `).bind(user_id).first();

        let commission = 0;
        let limit = 0;
        
        if (sub) { 
            commission = sub.commission; 
            limit = sub.daily_jobs_limit; 
        } else { 
            const freePlan = await env.DB.prepare('SELECT commission, daily_jobs_limit FROM plans WHERE id = 1').first(); 
            if(freePlan) { commission = freePlan.commission; limit = freePlan.daily_jobs_limit; } 
        }

        // 2. Cek Batas Harian
        const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
        const doneCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM task_completions WHERE user_id = ? AND completed_at >= ?`).bind(user_id, todayStart).first();

        if (doneCount.count >= limit) return jsonResponse({ error: 'Batas harian tercapai.' }, 403);

        // 3. Validasi Job & Cek Duplikasi
        const job = await env.DB.prepare('SELECT title FROM jobs WHERE id = ?').bind(job_id).first();
        if (!job) return jsonResponse({ error: 'Job tidak valid' }, 404);
        
        const checkDone = await env.DB.prepare('SELECT id FROM task_completions WHERE user_id = ? AND job_id = ? AND completed_at >= ?').bind(user_id, job_id, todayStart).first();
        if (checkDone) return jsonResponse({ error: 'Sudah diklaim hari ini' }, 400);

        // 4. Eksekusi Transaksi (Atomic)
        await env.DB.batch([
          // Log Task
          env.DB.prepare(`INSERT INTO task_completions (user_id, job_id, amount_earned) VALUES (?, ?, ?)`).bind(user_id, job_id, commission),
          // Log Ledger
          env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'income', ?, ?, 'success')`).bind(user_id, commission, `Reward: ${job.title}`),
          // Update Saldo
          env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).bind(commission, user_id)
        ]);

        return jsonResponse({ success: true, reward: commission });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
  return jsonResponse({ error: 'Invalid action' }, 400);
}
