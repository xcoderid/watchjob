import { jsonResponse, getUserBalance, authenticateUser } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  // Security Check
  const authUser = await authenticateUser(env, request);
  if (!authUser) return jsonResponse({ error: 'Unauthorized' }, 401);

  // User hanya boleh melihat datanya sendiri kecuali admin
  if (authUser.role !== 'admin' && authUser.id.toString() !== id) {
      return jsonResponse({ error: 'Forbidden' }, 403);
  }

  try {
    const user = await env.DB.prepare('SELECT id, username, email, referral_code, status, role, created_at FROM users WHERE id = ?').bind(id).first();
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    const balance = await getUserBalance(env, id);

    const plan = await env.DB.prepare(`
      SELECT p.name, p.daily_jobs_limit, p.commission, s.end_date, p.thumbnail_url
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(id).first();

    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    
    const incomeRes = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions 
      WHERE user_id = ? AND type IN ('income', 'commission') AND created_at >= ? AND status = 'success'
    `).bind(id, todayStart).first();

    const taskRes = await env.DB.prepare(`
      SELECT COUNT(*) as total FROM task_completions 
      WHERE user_id = ? AND completed_at >= ?
    `).bind(id, todayStart).first();

    return jsonResponse({
      user: {
        ...user,
        balance: balance,
        today_income: incomeRes.total || 0,
        tasks_done: taskRes.total || 0
      },
      plan: plan || { name: 'No Plan', daily_jobs_limit: 0, commission: 0 }
    });

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}
