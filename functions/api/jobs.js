export async function onRequestGet(context) {
  // --- GET JOBS ---
  const { request, env } = context;
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  // Jika user belum login/tidak punya plan, anggap level 1 (Trial)
  let planLevel = 1; 

  if (userId) {
     // Cek Plan Level user saat ini untuk filter jobs
     const sub = await env.DB.prepare(`
        SELECT p.id as plan_level 
        FROM user_subscriptions s
        JOIN plans p ON s.plan_id = p.id
        WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
     `).bind(userId).first();
     if (sub) planLevel = sub.plan_level;
  }

  // 1. Ambil Jobs (Table: jobs)
  const jobs = await env.DB.prepare(`
    SELECT * FROM jobs WHERE min_plan_level <= ? ORDER BY created_at DESC
  `).bind(planLevel).all();

  // 2. Cek task yang SUDAH selesai hari ini (Table: task_completions)
  const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
  
  const completed = await env.DB.prepare(`
    SELECT job_id FROM task_completions 
    WHERE user_id = ? AND completed_at >= ?
  `).bind(userId, todayStart).all();

  const completedIds = completed.results.map(row => row.job_id);

  return new Response(JSON.stringify({
    success: true,
    jobs: jobs.results,
    completed_ids: completedIds
  }));
}

export async function onRequestPost(context) {
  // --- CLAIM REWARD ---
  const { request, env } = context;
  const body = await request.json();
  const { action, user_id, job_id } = body; 

  if (action === 'start') {
    return new Response(JSON.stringify({ status: 'started', time: Date.now() }));
  }

  if (action === 'claim') {
    // 1. Cek Limit Harian User dari Plan
    const subscription = await env.DB.prepare(`
      SELECT p.daily_jobs_limit 
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user_id).first();

    // Default limit kecil jika tidak ada subskripsi
    const limit = subscription ? subscription.daily_jobs_limit : 0;

    // 2. Hitung jumlah task hari ini
    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    const doneCount = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM task_completions 
      WHERE user_id = ? AND completed_at >= ?
    `).bind(user_id, todayStart).first();

    if (doneCount.count >= limit) {
      return new Response(JSON.stringify({ error: 'Batas harian tercapai! Upgrade plan Anda.' }), { status: 403 });
    }

    // 3. Ambil data Job (terutama Reward Amount)
    const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(job_id).first();
    if (!job) return new Response(JSON.stringify({ error: 'Job tidak ditemukan' }), { status: 404 });

    // 4. Eksekusi Transaksi
    try {
      await env.DB.batch([
        // a. Catat penyelesaian (Table: task_completions)
        env.DB.prepare(`
            INSERT INTO task_completions (user_id, job_id, amount_earned) 
            VALUES (?, ?, ?)
        `).bind(user_id, job_id, job.reward_amount),

        // b. Catat transaksi (Table: transactions)
        env.DB.prepare(`
            INSERT INTO transactions (user_id, type, amount, description, status) 
            VALUES (?, 'income', ?, ?, 'success')
        `).bind(user_id, job.reward_amount, `Reward Job: ${job.title}`)
      ]);

      return new Response(JSON.stringify({ success: true, reward: job.reward_amount }));
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Database Error: ' + e.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
}
