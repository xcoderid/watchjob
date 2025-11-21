import { jsonResponse, authenticateUser, getUserBalance } from '../utils';

export async function onRequestGet(context) {
  const { env } = context;
  try {
      // Menampilkan semua plan kecuali yang hidden (Trial usually ID 1)
      const plans = await env.DB.prepare('SELECT * FROM plans WHERE is_active = 1 AND id != 1 ORDER BY price ASC').all();
      return jsonResponse(plans.results);
  } catch (e) {
      return jsonResponse({ error: e.message }, 500);
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { plan_id } = await request.json();

  try {
      const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
      if (!plan) return jsonResponse({ error: 'Plan tidak valid' }, 404);

      // --- LOGIKA BARU: Cek Syarat Referral Aktif ---
      // Jika plan memiliki syarat referral (min_active_referrals > 0)
      if (plan.min_active_referrals && plan.min_active_referrals > 0) {
          // Hitung jumlah referral langsung (L1) yang punya paket AKTIF dan BUKAN TRIAL (ID != 1)
          const activeRefs = await env.DB.prepare(`
            SELECT COUNT(DISTINCT u.id) as total
            FROM users u
            JOIN user_subscriptions s ON u.id = s.user_id
            WHERE u.referrer_id = ? 
              AND s.status = 'active' 
              AND s.end_date > CURRENT_TIMESTAMP
              AND s.plan_id != 1
          `).bind(user.id).first();

          const currentActive = activeRefs.total || 0;
          
          if (currentActive < plan.min_active_referrals) {
              return jsonResponse({ 
                  error: `Syarat tidak terpenuhi. Paket ini membutuhkan minimal ${plan.min_active_referrals} referral aktif (Bukan Trial). Anda memiliki: ${currentActive}.` 
              }, 403);
          }
      }
      // ---------------------------------------------

      const balance = await getUserBalance(env, user.id);
      if (balance < plan.price) return jsonResponse({ error: 'Saldo tidak mencukupi. Gunakan penghasilan job atau deposit.' }, 400);

      // Hitung masa aktif
      const end = new Date(); 
      end.setDate(end.getDate() + plan.duration_days);
      
      const ops = [];

      // 1. Potong Saldo & Update Status
      ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'expense', ?, ?, 'success')").bind(user.id, plan.price, `Beli Paket: ${plan.name}`));
      
      // Expire plan lama
      ops.push(env.DB.prepare("UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ?").bind(user.id));
      
      // Insert Plan Baru
      ops.push(env.DB.prepare("INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) VALUES (?, ?, ?, 'active')").bind(user.id, plan.id, end.toISOString()));

      // 2. LOGIKA KOMISI REFERRAL
      if (user.referrer_id && plan.id !== 1) {
          const uplineSub = await env.DB.prepare(`
            SELECT p.referral_percent, p.price as upline_plan_price, u.id
            FROM users u
            JOIN user_subscriptions s ON u.id = s.user_id
            JOIN plans p ON s.plan_id = p.id
            WHERE u.id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
          `).bind(user.referrer_id).first();

          if (uplineSub && uplineSub.referral_percent > 0) {
              let commission = (plan.price * uplineSub.referral_percent) / 100;

              // Capping: Maksimal dikalikan harga keanggotaannya sendiri
              if (commission > uplineSub.upline_plan_price) {
                  commission = uplineSub.upline_plan_price;
              }

              if (commission > 0) {
                  ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(uplineSub.id, commission, `Refferal Upgrade dari ${user.username}`));
              }
          }
      }

      await env.DB.batch(ops);
      return jsonResponse({ success: true, message: `Upgrade ke ${plan.name} Berhasil!` });
  } catch(e) {
      return jsonResponse({ error: e.message }, 500);
  }
}
