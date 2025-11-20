export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return new Response(JSON.stringify({ error: 'ID missing' }), { status: 400 });

  // 1. Ambil Info User & Balance (Menggunakan kolom 'balance' di tabel users untuk efisiensi O(1))
  const user = await env.DB.prepare('SELECT id, username, email, referral_code, status, role, balance FROM users WHERE id = ?').bind(id).first();
  if (!user) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  // 2. Ambil Plan Aktif
  const plan = await env.DB.prepare(`
    SELECT p.name, p.daily_jobs_limit, p.commission, s.end_date
    FROM user_subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
  `).bind(id).first();

  // 3. Hitung Statistik Hari Ini (Income & Task Count)
  // Ini masih perlu query SUM/COUNT, tapi hanya untuk data hari ini saja, bukan seluruh riwayat.
  const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
  const todayStats = await env.DB.prepare(`
    SELECT 
        COALESCE(SUM(amount), 0) as income,
        (SELECT COUNT(*) FROM task_completions WHERE user_id = ? AND completed_at >= ?) as tasks
    FROM transactions 
    WHERE user_id = ? AND type = 'income' AND created_at >= ?
  `).bind(id, todayStart, id, todayStart).first();

  return new Response(JSON.stringify({
    user: {
      ...user,
      balance: user.balance || 0, // Mengambil langsung dari kolom yang sudah terupdate
      today_income: todayStats.income,
      tasks_done: todayStats.tasks
    },
    plan: plan || null
  }));
}
