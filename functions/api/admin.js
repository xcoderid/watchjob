// functions/api/admin.js

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type'); // 'stats', 'users', 'plans'

  // --- STATISTIK DASHBOARD ---
  if (type === 'stats') {
    const userCount = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first();
    const depositSum = await env.DB.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'deposit' AND status = 'success'").first();
    const plansCount = await env.DB.prepare('SELECT COUNT(*) as total FROM user_subscriptions WHERE status = "active"').first();

    return new Response(JSON.stringify({
      total_users: userCount.total,
      total_deposit: depositSum.total || 0,
      active_plans: plansCount.total
    }));
  }

  // --- LIST USERS ---
  if (type === 'users') {
    // Join untuk dapat nama paket user
    const users = await env.DB.prepare(`
      SELECT u.id, u.username, u.status, u.created_at, 
             COALESCE(p.name, 'No Plan') as plan_name,
             (SELECT SUM(amount) FROM transactions WHERE user_id = u.id) as balance
      FROM users u
      LEFT JOIN user_subscriptions s ON u.id = s.user_id AND s.status = 'active'
      LEFT JOIN plans p ON s.plan_id = p.id
      ORDER BY u.created_at DESC LIMIT 50
    `).all();
    return new Response(JSON.stringify(users.results));
  }

  // --- LIST PLANS ---
  if (type === 'plans') {
    const plans = await env.DB.prepare('SELECT * FROM plans').all();
    return new Response(JSON.stringify(plans.results));
  }

  return new Response(JSON.stringify({ error: 'Invalid type' }), { status: 400 });
}

export async function onRequestPost(context) {
  // --- BUAT/EDIT DATA OLEH ADMIN ---
  const { request, env } = context;
  const body = await request.json();
  const { action } = body; // 'create_plan', 'create_job', 'toggle_user'

  if (action === 'create_plan') {
    const { name, price, duration, daily_jobs, daily_income, return_capital, watch_seconds, thumbnail } = body;
    await env.DB.prepare(`
      INSERT INTO plans (name, price, duration_days, daily_jobs_limit, daily_income, return_capital, video_duration_sec, thumbnail_url)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(name, price, duration, daily_jobs, daily_income, return_capital, watch_seconds, thumbnail).run();
    return new Response(JSON.stringify({ success: true }));
  }

  if (action === 'create_job') {
    const { title, url, reward, min_level } = body;
    await env.DB.prepare(`
      INSERT INTO jobs (title, youtube_url, reward_amount, min_plan_level)
      VALUES (?, ?, ?, ?)
    `).bind(title, url, reward, min_level).run();
    return new Response(JSON.stringify({ success: true }));
  }

  if (action === 'toggle_user') {
    const { user_id, status } = body; // status: 'active' or 'inactive'
    await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
    return new Response(JSON.stringify({ success: true }));
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
}
