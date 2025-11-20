import { jsonResponse } from '../utils';

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
  const { user_id, plan_id, coupon_code } = await request.json();

  try {
      const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
      if (!plan) return jsonResponse({ error: 'Plan tidak valid' }, 404);

      let finalPrice = plan.price;
      // Logika Kupon (Opsional)
      if (coupon_code) {
        const coupon = await env.DB.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1').bind(coupon_code).first();
        if (coupon && coupon.used_count < coupon.max_usage) {
          finalPrice = Math.max(0, plan.price - coupon.discount_amount);
          await env.DB.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').bind(coupon.id).run();
        }
      }

      const user = await env.DB.prepare('SELECT id, balance, referrer_id FROM users WHERE id = ?').bind(user_id).first();
      if (user.balance < finalPrice) return jsonResponse({ error: 'Saldo tidak cukup' }, 400);

      const end = new Date(); end.setDate(end.getDate() + plan.duration_days);
      
      // Transaksi
      await env.DB.batch([
          env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').bind(finalPrice, user_id),
          env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'expense', ?, ?, 'success')").bind(user_id, finalPrice, `Beli ${plan.name}`),
          env.DB.prepare("UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ?").bind(user_id),
          env.DB.prepare("INSERT INTO user_subscriptions (user_id, plan_id, end_date) VALUES (?, ?, ?)").bind(user_id, plan.id, end.toISOString())
      ]);

      // Affiliate (Sederhana)
      if (user.referrer_id && finalPrice > 0) {
          const ref = await env.DB.prepare("SELECT value FROM site_settings WHERE key='affiliate_l1'").first();
          const percent = ref ? parseFloat(ref.value) : 10;
          const comm = (finalPrice * percent) / 100;
          
          await env.DB.batch([
              env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(comm, user.referrer_id),
              env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(user.referrer_id, comm, `Komisi Referral`)
          ]);
      }

      return jsonResponse({ success: true, message: 'Paket aktif!' });
  } catch(e) {
      return jsonResponse({ error: e.message }, 500);
  }
}
