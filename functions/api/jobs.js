import { jsonResponse, authenticateUser } from '../utils';

export async function onRequestGet(context) {
  const { request, env } = context;
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    // Get Current Active Plan
    const sub = await env.DB.prepare(`
      SELECT p.id, p.commission, p.daily_jobs_limit
      FROM user_subscriptions s
      JOIN plans p ON s.plan_id = p.id
      WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
    `).bind(user.id).first();

    // Fallback to Free Plan (ID 1) or defaults if expired
    const activePlan = sub || { id: 1, commission: 0, daily_jobs_limit: 0 };

    // Show jobs suitable for user's plan level or lower
    const jobs = await env.DB.prepare(`
      SELECT id, title, youtube_url, duration, min_plan_level, created_at 
      FROM jobs 
      WHERE min_plan_level <= ? 
      ORDER BY created_at DESC LIMIT 20
    `).bind(activePlan.id).all();

    const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
    
    // Get completed jobs for today
    const completed = await env.DB.prepare(`
      SELECT job_id FROM task_completions 
      WHERE user_id = ? AND completed_at >= ?
    `).bind(user.id, todayStart).all();
    
    const completedIds = completed.results.map(row => row.job_id);

    return jsonResponse({
      success: true,
      user_commission: activePlan.commission,
      daily_limit: activePlan.daily_jobs_limit,
      jobs: jobs.results,
      completed_ids: completedIds
    });

  } catch (e) {
    return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { action, job_id } = body; 

  if (action === 'claim') {
    try {
        // Re-verify Plan Constraints
        const sub = await env.DB.prepare(`
          SELECT p.commission, p.daily_jobs_limit 
          FROM user_subscriptions s
          JOIN plans p ON s.plan_id = p.id
          WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
        `).bind(user.id).first();

        // Fallback logic
        let commission = 0;
        let limit = 0;
        if (sub) { 
            commission = sub.commission; 
            limit = sub.daily_jobs_limit; 
        } else {
             const free = await env.DB.prepare('SELECT commission, daily_jobs_limit FROM plans WHERE id = 1').first();
             if(free) { commission = free.commission; limit = free.daily_jobs_limit; }
        }

        // Check Daily Limit
        const todayStart = new Date().toISOString().split('T')[0] + ' 00:00:00';
        const doneCount = await env.DB.prepare(`SELECT COUNT(*) as count FROM task_completions WHERE user_id = ? AND completed_at >= ?`).bind(user.id, todayStart).first();

        if (doneCount.count >= limit) return jsonResponse({ error: 'Batas misi harian tercapai. Upgrade paket untuk lebih banyak.' }, 403);

        // Validate Job
        const job = await env.DB.prepare('SELECT title FROM jobs WHERE id = ?').bind(job_id).first();
        if (!job) return jsonResponse({ error: 'Job tidak valid' }, 404);
        
        // Check duplicate claim
        const checkDone = await env.DB.prepare('SELECT id FROM task_completions WHERE user_id = ? AND job_id = ? AND completed_at >= ?').bind(user.id, job_id, todayStart).first();
        if (checkDone) return jsonResponse({ error: 'Misi ini sudah diklaim hari ini.' }, 400);

        // Execute Transaction
        await env.DB.batch([
          env.DB.prepare(`INSERT INTO task_completions (user_id, job_id, amount_earned) VALUES (?, ?, ?)`).bind(user.id, job_id, commission),
          env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'income', ?, ?, 'success')`).bind(user.id, commission, `Reward: ${job.title}`)
        ]);

        return jsonResponse({ success: true, reward: commission, message: 'Komisi berhasil diklaim!' });
    } catch (e) {
      return jsonResponse({ error: e.message }, 500);
    }
  }
  return jsonResponse({ error: 'Invalid action' }, 400);
}
