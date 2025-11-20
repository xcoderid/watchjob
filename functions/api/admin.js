export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const type = url.searchParams.get('type');

  // --- 1. STATISTIK DASHBOARD (type=stats) ---
  if (type === 'stats') {
    const userCount = await env.DB.prepare('SELECT COUNT(*) as total FROM users').first();
    const depositSum = await env.DB.prepare("SELECT SUM(amount) as total FROM transactions WHERE type = 'deposit' AND status = 'success'").first();
    // Menghitung plan yang statusnya aktif DAN end_date belum lewat
    const plansCount = await env.DB.prepare("SELECT COUNT(*) as total FROM user_subscriptions WHERE status = 'active' AND end_date > CURRENT_TIMESTAMP").first();

    return new Response(JSON.stringify({
      total_users: userCount.total,
      total_deposit: depositSum.total || 0,
      active_plans: plansCount.total
    }));
  }

  // --- 2. LIST USERS (type=users) ---
  if (type === 'users') {
    // Mengambil data user, termasuk balance dan nama plan aktif
    const users = await env.DB.prepare(`
      SELECT u.id, u.username, u.email, u.status, u.created_at, u.balance,
             COALESCE(p.name, 'No Plan') as plan_name
      FROM users u
      LEFT JOIN user_subscriptions s ON u.id = s.user_id AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
      LEFT JOIN plans p ON s.plan_id = p.id
      ORDER BY u.created_at DESC LIMIT 50
    `).all();
    return new Response(JSON.stringify(users.results));
  }

  // --- 3. LIST PLANS (type=plans) ---
  if (type === 'plans') {
    // Mengambil semua plan (termasuk komisi per video)
    const plans = await env.DB.prepare('SELECT * FROM plans').all();
    return new Response(JSON.stringify(plans.results));
  }
  
  // --- 4. LIST JOBS (type=jobs) ---
  if (type === 'jobs') {
    // Mengambil semua job (termasuk durasi tonton)
    const jobs = await env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 50').all();
    return new Response(JSON.stringify(jobs.results));
  }

  return new Response(JSON.stringify({ error: 'Invalid type' }), { status: 400 });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const body = await request.json();
  const { action } = body;

  // --- 1. CREATE/EDIT PLAN (action=create_plan) ---
  if (action === 'create_plan') {
    // Menggunakan kolom commission
    const { name, price, duration, daily_jobs, commission, thumbnail } = body;
    
    await env.DB.prepare(`
      INSERT INTO plans (name, price, duration_days, daily_jobs_limit, commission, thumbnail_url, is_active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).bind(name, price, duration, daily_jobs, commission, thumbnail).run();
    
    return new Response(JSON.stringify({ success: true }));
  }

  // --- 2. CREATE/EDIT JOB (action=create_job) ---
  if (action === 'create_job') {
    // Menggunakan kolom duration
    const { title, url, duration, min_level } = body;
    
    await env.DB.prepare(`
      INSERT INTO jobs (title, youtube_url, duration, min_plan_level)
      VALUES (?, ?, ?, ?)
    `).bind(title, url, duration || 30, min_level || 1).run();
    
    return new Response(JSON.stringify({ success: true }));
  }

  // --- 3. TOGGLE USER STATUS (action=toggle_user) ---
  if (action === 'toggle_user') {
    const { user_id, status } = body; 
    await env.DB.prepare('UPDATE users SET status = ? WHERE id = ?').bind(status, user_id).run();
    return new Response(JSON.stringify({ success: true }));
  }

  return new Response(JSON.stringify({ error: 'Invalid action' }), { status: 400 });
}
