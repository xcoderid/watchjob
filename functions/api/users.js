export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  // Validasi ID
  if (!id) {
    return new Response(JSON.stringify({ error: 'ID parameter is required' }), { status: 400 });
  }

  // 1. Ambil Data User & Balance
  // Mengambil kolom 'balance' langsung dari tabel users (bukan hitung ulang semua transaksi)
  const user = await env.DB.prepare(`
    SELECT id, username, email, referral_code, status, role, balance 
    FROM users 
    WHERE id = ?
  `).bind(id).first();

  if (!user) {
    return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });
  }

  // 2. Ambil Plan Aktif
  // Mengambil detail plan jika status active dan belum expired
  const plan = await env.DB.prepare(`
    SELECT p.name, p.daily_jobs_limit, p.commission, p.video_duration_sec, s.end_date
    FROM user_subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
  `).bind(id).first();

  // 3. Hitung Statistik Hari Ini
  // Format tanggal hari ini (YYYY-MM-DD 00:00:00) untuk filter query
  const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';

  // a. Hitung Income Hari Ini (Hanya transaksi tipe 'income' hari ini)
  const incomeResult = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount), 0) as total
    FROM transactions 
    WHERE user_id = ? AND type = 'income' AND created_at >= ?
  `).bind(id, todayStart).first();

  // b. Hitung Jumlah Task Selesai Hari Ini
  const tasksResult = await env.DB.prepare(`
    SELECT COUNT(*) as count 
    FROM task_completions 
    WHERE user_id = ? AND completed_at >= ?
  `).bind(id, todayStart).first();

  // 4. Return Response JSON
  return new Response(JSON.stringify({
    user: {
      ...user,
      balance: user.balance || 0, // Pastikan tidak null
      today_income: incomeResult.total || 0,
      tasks_done: tasksResult.count || 0
    },
    plan: plan || null
  }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
