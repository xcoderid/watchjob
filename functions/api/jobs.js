export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');

  if (!userId) return new Response(JSON.stringify({ error: 'User ID required' }), { status: 400 });

  // 1. Tentukan Komisi dan Limit berdasarkan Plan User
  const sub = await env.DB.prepare(`
    SELECT p.id, p.commission, p.daily_jobs_limit
    FROM user_subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
  `).bind(userId).first();

  // Fallback ke Trial (Plan ID 1) jika tidak ada plan aktif
  let planInfo = sub;
  if (!planInfo) {
      planInfo = await env.DB.prepare('SELECT id, commission, daily_jobs_limit FROM plans WHERE id = 1').first();
  }

  // 2. Ambil Jobs (mengandung durasi dan level minimum)
  const jobs = await env.DB.prepare(`
    SELECT * FROM jobs WHERE min_plan_level <= ? ORDER BY created_at DESC
  `).bind(planInfo ? planInfo.id : 1).all();

  // 3. Cek Job yang sudah selesai hari ini
  const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
  const completed = await env.DB.prepare(`
    SELECT job_id FROM task_completions 
    WHERE user_id = ? AND completed_at >= ?
  `).bind(userId, todayStart).all();
  
  const completedIds = completed.results.map(row => row.job_id);

  return new Response(JSON.stringify({
    success: true,
    user_commission: planInfo ? planInfo.commission : 0, // Komisi per tontonan
    daily_limit: planInfo ? planInfo.daily_jobs_limit : 0,
    jobs: jobs.results,
    completed_ids: completedIds
  }));
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { action, user_id, job_id } = body; 

  if (action === 'claim') {
    // 1. Tentukan Komisi dari Plan User
    const sub = await env.DB.prepare(`
      SELECT p.commission, p.daily_jobs_limit 
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user_id).first();

    let commission = 0;
    let limit = 0;
    
    if (sub) { commission = sub.commission; limit = sub.daily_jobs_limit; } 
    else { const freePlan = await env.DB.prepare('SELECT commission, daily_jobs_limit FROM plans WHERE id = 1').first(); if(freePlan) { commission = freePlan.commission; limit = freePlan.daily_jobs_limit; } }

    // 2. Cek Batas Harian
    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    const doneCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM task_completions WHERE user_id = ? AND completed_at >= ?`).bind(user_id, todayStart).first();

    if (doneCount.count >= limit) return new Response(JSON.stringify({ error: 'Batas harian tercapai.' }), { status: 403 });

    // 3. Validasi Job & Duplikasi
    const job = await env.DB.prepare('SELECT title FROM jobs WHERE id = ?').bind(job_id).first();
    if (!job) return new Response(JSON.stringify({ error: 'Job tidak valid' }), { status: 404 });
    
    const checkDone = await env.DB.prepare('SELECT id FROM task_completions WHERE user_id = ? AND job_id = ? AND completed_at >= ?').bind(user_id, job_id, todayStart).first();
    if (checkDone) return new Response(JSON.stringify({ error: 'Sudah diklaim hari ini' }), { status: 400 });

    // 4. Eksekusi Update Saldo & Log (Atomic Batch)
    try {
      await env.DB.batch([
        // Log Penyelesaian Task
        env.DB.prepare(`INSERT INTO task_completions (user_id, job_id, amount_earned) VALUES (?, ?, ?)`).bind(user_id, job_id, commission),
        // Log Transaksi (Ledger)
        env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'income', ?, ?, 'success')`).bind(user_id, commission, `Tonton: ${job.title}`),
        // Update Saldo User (Hemat CPU)
        env.DB.prepare(`UPDATE users SET balance = balance + ? WHERE id = ?`).bind(commission, user_id)
      ]);

      return new Response(JSON.stringify({ success: true, reward: commission }));
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  }
  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
}
