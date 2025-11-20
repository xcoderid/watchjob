import { jsonResponse, authenticateUser, getUserBalance } from '../utils';

export async function onRequestGet(context) {
  const { env } = context;
  try {
      const plans = await env.DB.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
      return jsonResponse(plans.results);
  } catch (e) {
      return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { plan_id } = await request.json(); // Removed coupon for simplicity/robustness

  try {
      const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
      if (!plan) return jsonResponse({ error: 'Plan tidak valid' }, 404);

      const balance = await getUserBalance(env, user.id);
      if (balance < plan.price) return jsonResponse({ error: 'Saldo tidak mencukupi. Silakan deposit.' }, 400);

      const end = new Date(); 
      end.setDate(end.getDate() + plan.duration_days);
      
      const ops = [];

      // 1. Deduct Balance
      ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'expense', ?, ?, 'success')").bind(user.id, plan.price, `Beli Paket: ${plan.name}`));
      
      // 2. Update Subscription (Expire old ones)
      ops.push(env.DB.prepare("UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ?").bind(user.id));
      ops.push(env.DB.prepare("INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) VALUES (?, ?, ?, 'active')").bind(user.id, plan.id, end.toISOString()));

      // 3. Affiliate Commission System (L1, L2, L3)
      if (user.referrer_id && plan.price > 0) {
          const settingsRes = await env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'affiliate_l%'").all();
          const rates = { 'affiliate_l1': 10, 'affiliate_l2': 5, 'affiliate_l3': 2 }; // Defaults
          
          if(settingsRes.results) {
              settingsRes.results.forEach(s => rates[s.key] = parseFloat(s.value));
          }

          // Level 1
          const l1 = await env.DB.prepare('SELECT id, referrer_id FROM users WHERE id = ?').bind(user.referrer_id).first();
          if (l1) {
             const comm1 = (plan.price * rates['affiliate_l1']) / 100;
             if(comm1 > 0) ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l1.id, comm1, `Komisi L1 dari ${user.username}`));
             
             // Level 2
             if (l1.referrer_id) {
                 const l2 = await env.DB.prepare('SELECT id, referrer_id FROM users WHERE id = ?').bind(l1.referrer_id).first();
                 if(l2) {
                     const comm2 = (plan.price * rates['affiliate_l2']) / 100;
                     if(comm2 > 0) ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l2.id, comm2, `Komisi L2 dari ${user.username}`));
                     
                     // Level 3
                     if (l2.referrer_id) {
                        const l3 = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(l2.referrer_id).first();
                        if(l3) {
                            const comm3 = (plan.price * rates['affiliate_l3']) / 100;
                            if(comm3 > 0) ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l3.id, comm3, `Komisi L3 dari ${user.username}`));
                        }
                     }
                 }
             }
          }
      }

      await env.DB.batch(ops);
      return jsonResponse({ success: true, message: `Berhasil upgrade ke ${plan.name}!` });
  } catch(e) {
      return jsonResponse({ error: e.message }, 500);
  }
}
