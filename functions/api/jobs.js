// functions/api/jobs.js

export async function onRequestGet(context) {
  // --- GET: AMBIL DAFTAR JOBS ---
  const { request, env } = context;
  const url = new URL(request.url);
  const userId = url.searchParams.get('user_id');
  const planId = url.searchParams.get('plan_id') || 1;

  if (!userId) return new Response(JSON.stringify({ error: 'User ID required' }), { status: 400 });

  // 1. Ambil Jobs sesuai level plan
  const jobs = await env.DB.prepare(`
    SELECT * FROM jobs WHERE min_plan_level <= ? ORDER BY created_at DESC
  `).bind(planId).all();

  // 2. Cek pekerjaan yang SUDAH dilakukan HARI INI
  // Format SQLite date comparison: YYYY-MM-DD
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
  // --- POST: KLAIM REWARD / START JOB ---
  const { request, env } = context;
  const body = await request.json();
  const { action, user_id, job_id } = body; 
  // action bisa 'start' atau 'claim'

  if (action === 'start') {
    // Hanya log start time, bisa disimpan di Durable Objects atau KV untuk validasi ketat
    // Untuk versi simple, kita return OK saja
    return new Response(JSON.stringify({ status: 'started', time: Date.now() }));
  }

  if (action === 'claim') {
    // 1. Ambil Info User & Plan Aktif
    const subscription = await env.DB.prepare(`
      SELECT p.daily_jobs_limit 
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active'
    `).bind(user_id).first();

    // Jika tidak ada paket aktif, anggap limit 0 atau fallback ke trial
    const limit = subscription ? subscription.daily_jobs_limit : 0;

    // 2. Hitung tugas yang sudah selesai hari ini
    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    const doneCountResult = await env.DB.prepare(`
      SELECT COUNT(*) as count FROM task_completions 
      WHERE user_id = ? AND completed_at >= ?
    `).bind(user_id, todayStart).first();

    if (doneCountResult.count >= limit) {
      return new Response(JSON.stringify({ error: 'Batas harian tercapai! Upgrade paket untuk lebih banyak.' }), { status: 403 });
    }

    // 3. Ambil Info Job dan Reward
    const job = await env.DB.prepare('SELECT * FROM jobs WHERE id = ?').bind(job_id).first();
    if (!job) return new Response(JSON.stringify({ error: 'Job tidak valid' }), { status: 404 });

    // 4. PROSES TRANSAKSI (Batch)
    // a. Catat Task Selesai
    // b. Tambah history transaksi
    // c. Update saldo user (Kita tidak simpan saldo di tabel user agar aman, tapi hitung sum transaksi. 
    //    TAPI, agar cepat query di frontend, kita update tabel users kolom saldo jika ada, 
    //    atau biarkan frontend hitung. Di skema SQL sebelumnya tidak ada kolom 'balance' di tabel users,
    //    jadi kita insert ke 'transactions' saja. Nanti saldo = SUM(transactions).

    try {
      await env.DB.batch([
        env.DB.prepare('INSERT INTO task_completions (user_id, job_id, amount_earned) VALUES (?, ?, ?)').bind(user_id, job_id, job.reward_amount),
        env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'income', ?, ?, 'success')").bind(user_id, job.reward_amount, `Reward: ${job.title}`)
      ]);

      return new Response(JSON.stringify({ success: true, reward: job.reward_amount }));
    } catch (e) {
      return new Response(JSON.stringify({ error: 'Database error: ' + e.message }), { status: 500 });
    }
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
}
