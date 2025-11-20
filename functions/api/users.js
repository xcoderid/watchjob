// functions/api/user.js

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return new Response(JSON.stringify({ error: 'ID missing' }), { status: 400 });

  // 1. Ambil Basic Info
  const user = await env.DB.prepare('SELECT id, username, email, referral_code, status, role FROM users WHERE id = ?').bind(id).first();
  if (!user) return new Response(JSON.stringify({ error: 'User not found' }), { status: 404 });

  // 2. Hitung Saldo (Total Income - Total Withdraw/Expense)
  const balanceResult = await env.DB.prepare(`
    SELECT SUM(amount) as total FROM transactions WHERE user_id = ? AND status = 'success'
  `).bind(id).first();
  
  // 3. Ambil Plan Aktif
  const plan = await env.DB.prepare(`
    SELECT p.name, p.daily_jobs_limit, p.video_duration_sec, s.end_date
    FROM user_subscriptions s
    JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active'
  `).bind(id).first();

  // 4. Hitung Statistik Harian (Income hari ini)
  const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
  const todayIncome = await env.DB.prepare(`
    SELECT SUM(amount) as total FROM transactions 
    WHERE user_id = ? AND type = 'income' AND created_at >= ?
  `).bind(id, todayStart).first();

  // 5. Hitung Task Harian
  const todayTasks = await env.DB.prepare(`
    SELECT COUNT(*) as count FROM task_completions 
    WHERE user_id = ? AND completed_at >= ?
  `).bind(id, todayStart).first();

  return new Response(JSON.stringify({
    user: {
      ...user,
      balance: balanceResult.total || 0,
      today_income: todayIncome.total || 0,
      tasks_done: todayTasks.count || 0
    },
    plan: plan || null
  }));
}
