export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return new Response(JSON.stringify({ error: 'ID missing' }), { status: 400 });

  // 1. Ambil Info User
  const user = await env.DB.prepare('SELECT id, username, email, referral_code, status, role FROM users WHERE id = ?').bind(id).first();
  if (!user) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  // 2. Hitung Balance Real-time dari Tabel Transactions
  // Income/Deposit menambah, Withdrawal mengurangi
  const balanceQuery = await env.DB.prepare(`
    SELECT 
      SUM(CASE WHEN type IN ('deposit', 'income', 'bonus') THEN amount ELSE 0 END) - 
      SUM(CASE WHEN type IN ('withdrawal') THEN amount ELSE 0 END) as current_balance
    FROM transactions 
    WHERE user_id = ? AND status = 'success'
  `).bind(id).first();
  
  const currentBalance = balanceQuery.current_balance || 0;

  // 3. Ambil Plan Aktif
  const plan = await env.DB.prepare(`
    SELECT p.name, p.daily_jobs_limit, p.video_duration_sec, p.daily_income, s.end_date
    FROM user_subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
  `).bind(id).first();

  // 4. Statistik Hari Ini (Income)
  const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
  const todayIncome = await env.DB.prepare(`
    SELECT SUM(amount) as total FROM transactions 
    WHERE user_id = ? AND type = 'income' AND created_at >= ?
  `).bind(id, todayStart).first();

  // 5. Statistik Hari Ini (Task Count)
  const todayTasks = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM task_completions 
    WHERE user_id = ? AND completed_at >= ?
  `).bind(id, todayStart).first();

  return new Response(JSON.stringify({
    user: {
      ...user,
      balance: currentBalance,
      today_income: todayIncome.total || 0,
      tasks_done: todayTasks.count || 0
    },
    plan: plan || null
  }));
}
