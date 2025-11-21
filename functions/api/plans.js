import { jsonResponse, authenticateUser, updateUserBalance } from '../utils';

/**
 * HANDLE GET REQUEST (Mengambil daftar plan yang aktif)
 */
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

/**
 * HANDLE POST REQUEST (Pembelian Paket Membership)
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const { plan_id } = await request.json();

  try {
      const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
      if (!plan) return jsonResponse({ error: 'Plan tidak valid' }, 404);

      const finalPrice = plan.price;

      // 1. Cek Saldo dan Syarat Referral
      if (user.balance < finalPrice) {
          return jsonResponse({ error: 'Saldo tidak mencukupi.' }, 400);
      }
      
      // Cek Syarat Referral Aktif (jika min_active_referrals > 0)
      if (plan.min_active_referrals && plan.min_active_referrals > 0) {
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
                  error: `Syarat tidak terpenuhi. Butuh ${plan.min_active_referrals} referral aktif (Bukan Trial). Anda memiliki: ${currentActive}.` 
              }, 403);
          }
      }

      // Hitung masa aktif
      const end = new Date(); 
      end.setDate(end.getDate() + plan.duration_days);
      
      const ops = [];
      const userId = user.id;

      // 2. Potong Saldo & Catat Transaksi Expense
      ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'expense', ?, ?, 'success')").bind(userId, finalPrice, `Beli Paket: ${plan.name}`));
      
      // KRITIS: Langsung perbarui kolom users.balance (DEBIT)
      await updateUserBalance(env, userId, -finalPrice);

      // 3. Update Subscription
      ops.push(env.DB.prepare("UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ?").bind(userId));
      ops.push(env.DB.prepare("INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) VALUES (?, ?, ?, 'active')").bind(userId, plan.id, end.toISOString()));

      // 4. LOGIKA KOMISI REFERRAL (Untuk Upline)
      // Komisi Referral diambil dari SETTINGS GLOBAL (L1, L2, L3)
      if (user.referrer_id && plan.id !== 1) {
          
          const settingsRes = await env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'affiliate_l%'").all();
          // Gunakan rates default jika setting kosong
          const rates = { 'affiliate_l1': 10, 'affiliate_l2': 5, 'affiliate_l3': 2 }; 
          if(settingsRes.results) { settingsRes.results.forEach(s => rates[s.key] = parseFloat(s.value)); }

          // --- Level 1 (Direct Upline) ---
          const l1 = await env.DB.prepare('SELECT id, referrer_id, username FROM users WHERE id = ?').bind(user.referrer_id).first();
          if (l1) {
             const uplinePlan = await env.DB.prepare(`
                SELECT p.price as upline_plan_price 
                FROM user_subscriptions s 
                JOIN plans p ON s.plan_id = p.id 
                WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
             `).bind(l1.id).first();
             
             // Pastikan upline memiliki paket aktif (untuk capping)
             if (uplinePlan) { 
                 const referralRate = rates['affiliate_l1'] || 0;
                 let commissionL1 = (finalPrice * referralRate) / 100;
                 
                 // Capping: Maksimal komisi tidak boleh melebihi harga paket Upline
                 if (commissionL1 > uplinePlan.upline_plan_price) { commissionL1 = uplinePlan.upline_plan_price; }

                 if (commissionL1 > 0) {
                     ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l1.id, commissionL1, `Refferal L1 dari ${user.username}`));
                     await updateUserBalance(env, l1.id, commissionL1); // KRITIS: Update Saldo Upline L1
                 }

                 // --- Level 2 ---
                 if (l1.referrer_id) {
                     const l2 = await env.DB.prepare('SELECT id, referrer_id FROM users WHERE id = ?').bind(l1.referrer_id).first();
                     const uplineL2Plan = await env.DB.prepare(`
                        SELECT p.price as upline_plan_price 
                        FROM user_subscriptions s JOIN plans p ON s.plan_id = p.id 
                        WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
                     `).bind(l2.id).first();

                     if (l2 && uplineL2Plan) {
                         const referralRateL2 = rates['affiliate_l2'] || 0;
                         let commissionL2 = (finalPrice * referralRateL2) / 100;
                         if (commissionL2 > uplineL2Plan.upline_plan_price) { commissionL2 = uplineL2Plan.upline_plan_price; }

                         if (commissionL2 > 0) {
                             ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l2.id, commissionL2, `Refferal L2 dari ${user.username}`));
                             await updateUserBalance(env, l2.id, commissionL2); // KRITIS: Update Saldo Upline L2
                         }
                         
                         // --- Level 3 ---
                         if (l2.referrer_id) {
                             const l3 = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(l2.referrer_id).first();
                             const uplineL3Plan = await env.DB.prepare(`
                                SELECT p.price as upline_plan_price 
                                FROM user_subscriptions s JOIN plans p ON s.plan_id = p.id 
                                WHERE s.user_id = ? AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
                             `).bind(l3.id).first();

                             if (l3 && uplineL3Plan) {
                                 const referralRateL3 = rates['affiliate_l3'] || 0;
                                 let commissionL3 = (finalPrice * referralRateL3) / 100;
                                 if (commissionL3 > uplineL3Plan.upline_plan_price) { commissionL3 = uplineL3Plan.upline_plan_price; }
                                 
                                 if (commissionL3 > 0) {
                                     ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')").bind(l3.id, commissionL3, `Refferal L3 dari ${user.username}`));
                                     await updateUserBalance(env, l3.id, commissionL3); // KRITIS: Update Saldo Upline L3
                                 }
                             }
                         }
                     }
                 }
              }
          }
      }

      await env.DB.batch(ops);
      return jsonResponse({ success: true, message: `Upgrade ke ${plan.name} Berhasil!` });
  } catch(e) {
      return jsonResponse({ error: e.message }, 500);
  }
}
