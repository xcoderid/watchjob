import { jsonResponse } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return jsonResponse({ error: 'User ID required' }, 400);

  try {
    const user = await env.DB.prepare('SELECT id, username, email, referral_code, status, role, balance FROM users WHERE id = ?').bind(id).first();
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    const plan = await env.DB.prepare(`
      SELECT p.name, p.daily_jobs_limit, p.commission, s.end_date
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(id).first();

    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    
    // Gunakan COALESCE agar tidak null
    const incomeRes = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions 
      WHERE user_id = ? AND type IN ('income', 'commission') AND created_at >= ?
    `).bind(id, todayStart).first();

    const taskRes = await env.DB.prepare(`
      SELECT COUNT(*) as total FROM task_completions 
      WHERE user_id = ? AND completed_at >= ?
    `).bind(id, todayStart).first();

    return jsonResponse({
      user: {
        ...user,
        today_income: incomeRes.total || 0,
        tasks_done: taskRes.total || 0
      },
      plan: plan || null
    });

  } catch (e) {
    return jsonResponse({ error: 'Server Error: ' + e.message }, 500);
  }
}
