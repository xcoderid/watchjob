import { jsonResponse } from '../utils';

export async function onRequestGet(context) {
  const { env } = context;
  const plans = await env.DB.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY price ASC').all();
  return jsonResponse(plans.results);
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const { user_id, plan_id, coupon_code } = await request.json();

  // 1. Validasi Plan
  const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
  if (!plan) return jsonResponse({ error: 'Plan tidak valid' }, 404);

  // 2. Cek Kupon
  let finalPrice = plan.price;
  if (coupon_code) {
    const coupon = await env.DB.prepare('SELECT * FROM coupons WHERE code = ? AND is_active = 1').bind(coupon_code).first();
    if (coupon && coupon.used_count < coupon.max_usage) {
      finalPrice = Math.max(0, plan.price - coupon.discount_amount);
      await env.DB.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE id = ?').bind(coupon.id).run();
    } else {
      return jsonResponse({ error: 'Kupon tidak valid atau habis' }, 400);
    }
  }

  // 3. Cek Saldo User
  const user = await env.DB.prepare('SELECT id, balance, referrer_id FROM users WHERE id = ?').bind(user_id).first();
  if (user.balance < finalPrice) return jsonResponse({ error: 'Saldo tidak cukup' }, 400);

  // 4. Proses Pembelian & Affiliate (Batch Transaction)
  const end = new Date(); end.setDate(end.getDate() + plan.duration_days);
  const ops = [];

  // Potong Saldo & Aktifkan Plan
  ops.push(env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').bind(finalPrice, user_id));
  ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'expense', ?, ?, 'success')").bind(user_id, finalPrice, `Beli ${plan.name}`));
  ops.push(env.DB.prepare("UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ?").bind(user_id));
  ops.push(env.DB.prepare("INSERT INTO user_subscriptions (user_id, plan_id, end_date) VALUES (?, ?, ?)").bind(user_id, plan.id, end.toISOString()));

  // --- LOGIKA AFFILIATE 3 LEVEL ---
  // Ambil persentase dari settings
  const settings = await env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'affiliate_l%'").all();
  const rates = {};
  settings.results.forEach(s => rates[s.key] = parseFloat(s.value));

  // Level 1
  if (user.referrer_id) {
    const l1 = await env.DB.prepare('SELECT id, referrer_id FROM users WHERE id = ?').bind(user.referrer_id).first();
    if (l1) {
      const comm1 = (finalPrice * (rates['affiliate_l1'] || 10)) / 100;
      if(comm1 > 0) {
          ops.push(env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(comm1, l1.id));
          ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l1.id, comm1, `Komisi L1 dari User #${user_id}`));
      }

      // Level 2
      if (l1.referrer_id) {
        const l2 = await env.DB.prepare('SELECT id, referrer_id FROM users WHERE id = ?').bind(l1.referrer_id).first();
        if (l2) {
          const comm2 = (finalPrice * (rates['affiliate_l2'] || 5)) / 100;
          if(comm2 > 0) {
              ops.push(env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(comm2, l2.id));
              ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l2.id, comm2, `Komisi L2 dari User #${user_id}`));
          }

          // Level 3
          if (l2.referrer_id) {
            const l3 = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(l2.referrer_id).first();
            if (l3) {
              const comm3 = (finalPrice * (rates['affiliate_l3'] || 2)) / 100;
              if(comm3 > 0) {
                  ops.push(env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(comm3, l3.id));
                  ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l3.id, comm3, `Komisi L3 dari User #${user_id}`));
              }
            }
          }
        }
      }
    }
  }

  await env.DB.batch(ops);
  return jsonResponse({ success: true, message: 'Paket aktif!' });
}
