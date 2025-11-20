import { jsonResponse } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) return jsonResponse({ error: 'User ID required' }, 400);

  try {
    // 1. Ambil Data User
    const user = await env.DB.prepare('SELECT id, username, email, referral_code, status, role, balance FROM users WHERE id = ?').bind(id).first();
    
    if (!user) return jsonResponse({ error: 'User not found' }, 404);

    // 2. Ambil Plan Aktif
    const plan = await env.DB.prepare(`
      SELECT p.name, p.daily_jobs_limit, p.commission, s.end_date
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(id).first();

    // 3. Hitung Statistik Hari Ini
    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    
    // Hitung Income (Hanya dari income tugas & komisi)
    const incomeRes = await env.DB.prepare(`
      SELECT COALESCE(SUM(amount), 0) as total
      FROM transactions 
      WHERE user_id = ? AND type IN ('income', 'commission') AND created_at >= ?
    `).bind(id, todayStart).first();

    // Hitung Tugas Selesai
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
