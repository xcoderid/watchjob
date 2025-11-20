export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return new Response(JSON.stringify({ error: 'ID missing' }), { status: 400 });

  // Ambil User & Balance langsung dari tabel users (Kolom balance wajib ada di DB)
  const user = await env.DB.prepare('SELECT id, username, email, referral_code, status, role, balance FROM users WHERE id = ?').bind(id).first();
  if (!user) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  const plan = await env.DB.prepare(`
    SELECT p.name, p.daily_jobs_limit, p.commission, s.end_date
    FROM user_subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
  `).bind(id).first();

  const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
  
  // Statistik sederhana hari ini
  const todayIncomeResult = await env.DB.prepare(`
    SELECT COALESCE(SUM(amount), 0) as income
    FROM transactions 
    WHERE user_id = ? AND type = 'income' AND created_at >= ?
  `).bind(id, todayStart).first();

  const todayTasksResult = await env.DB.prepare(`
    SELECT COUNT(*) as tasks FROM task_completions 
    WHERE user_id = ? AND completed_at >= ?
  `).bind(id, todayStart).first();

  return new Response(JSON.stringify({
    user: {
      ...user,
      balance: user.balance || 0,
      today_income: todayIncomeResult.income || 0,
      tasks_done: todayTasksResult.tasks || 0
    },
    plan: plan || null
  }));
}
