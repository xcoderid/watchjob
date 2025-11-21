import { jsonResponse, authenticateUser, updateUserBalance } from '../utils';

/**
 * HANDLE GET REQUEST (Mengambil daftar plan yang aktif)
 */
export async function onRequestGet(context) {
  const { env } = context;
  try {
      // Menampilkan semua plan kecuali yang hidden (Trial biasanya ID 1)
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
      // 1. Ambil Detail Plan yang akan dibeli
      const plan = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(plan_id).first();
      if (!plan) return jsonResponse({ error: 'Plan tidak valid' }, 404);

      const finalPrice = plan.price;

      // 2. Cek Saldo User
      if (user.balance < finalPrice) {
          return jsonResponse({ error: 'Saldo tidak mencukupi.' }, 400);
      }
      
      // 3. Cek Syarat Minimum Referral Aktif (Jika ada)
      if (plan.min_active_referrals && plan.min_active_referrals > 0) {
          // Hitung referral langsung yang punya paket aktif DAN bukan Trial (ID 1)
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
                  error: `Syarat tidak terpenuhi. Paket ini membutuhkan ${plan.min_active_referrals} referral aktif (Bukan Trial). Anda saat ini memiliki: ${currentActive}.` 
              }, 403);
          }
      }

      // 4. Mulai Transaksi Pembelian
      const end = new Date(); 
      end.setDate(end.getDate() + plan.duration_days);
      
      const ops = [];
      const userId = user.id;

      // A. Potong Saldo & Catat Pengeluaran
      ops.push(env.DB.prepare("INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'expense', ?, ?, 'success')").bind(userId, finalPrice, `Beli Paket: ${plan.name}`));
      await updateUserBalance(env, userId, -finalPrice); // Kurangi saldo user

      // B. Update Subscription (Matikan yang lama, buat yang baru)
      ops.push(env.DB.prepare("UPDATE user_subscriptions SET status = 'expired' WHERE user_id = ?").bind(userId));
      ops.push(env.DB.prepare("INSERT INTO user_subscriptions (user_id, plan_id, end_date, status) VALUES (?, ?, ?, 'active')").bind(userId, plan.id, end.toISOString()));

      // 5. DISTRIBUSI KOMISI REFERRAL (UPGRADE)
      // Syarat: User punya upline, dan paket yang dibeli BUKAN paket Trial (ID 1)
      if (user.referrer_id && plan.id !== 1) {
          
          // Ambil Settings Global untuk Persentase Komisi
          const settingsRes = await env.DB.prepare("SELECT key, value FROM site_settings WHERE key LIKE 'affiliate_l%'").all();
          const rates = { 'affiliate_l1': 0, 'affiliate_l2': 0, 'affiliate_l3': 0 }; 
          if(settingsRes.results) { 
              settingsRes.results.forEach(s => rates[s.key] = parseFloat(s.value)); 
          }

          // Fungsi helper untuk memproses komisi per level
          const processLevel = async (uplineId, levelKey) => {
              if (!uplineId) return null;
              
              // Ambil data upline dan PAKET AKTIF upline tersebut (untuk Capping)
              const uplineData = await env.DB.prepare(`
                SELECT u.id, u.username, u.referrer_id,
                       p.price as active_plan_price, p.id as active_plan_id
                FROM users u
                LEFT JOIN user_subscriptions s ON u.id = s.user_id AND s.status = 'active' AND s.end_date > CURRENT_TIMESTAMP
                LEFT JOIN plans p ON s.plan_id = p.id
                WHERE u.id = ?
              `).bind(uplineId).first();

              if (!uplineData) return null;

              // Cek apakah upline punya paket aktif. Jika tidak atau Trial (ID 1), biasanya tidak dapat komisi (atau tetap dapat tapi kecil).
              // Di sini kita asumsikan: Jika tidak ada paket aktif atau Trial, price dianggap 0 atau sangat kecil, 
              // sehingga capping akan membuat komisi jadi 0 atau kecil.
              const uplineCap = uplineData.active_plan_price || 0; 
              
              const rate = rates[levelKey] || 0;
              if (rate > 0) {
                  let commission = (finalPrice * rate) / 100;

                  // ATURAN CAPPING: Komisi tidak boleh lebih besar dari harga paket upline sendiri
                  if (commission > uplineCap) {
                      commission = uplineCap;
                  }

                  if (commission > 0) {
                      ops.push(env.DB.prepare(`INSERT INTO transactions (user_id, type, amount, description, status) VALUES (?, 'commission', ?, ?, 'success')`).bind(uplineData.id, commission, `Bonus Referral L${levelKey.slice(-1)} dari ${user.username}`));
                      await updateUserBalance(env, uplineData.id, commission); // Tambah saldo upline
                  }
              }

              return uplineData.referrer_id; // Return ID upline berikutnya untuk chain
          };

          // Proses Level 1
          const l2Id = await processLevel(user.referrer_id, 'affiliate_l1');
          
          // Proses Level 2 (jika ada upline L2)
          if (l2Id) {
              const l3Id = await processLevel(l2Id, 'affiliate_l2');
              
              // Proses Level 3 (jika ada upline L3)
              if (l3Id) {
                  await processLevel(l3Id, 'affiliate_l3');
              }
          }
      }

      // Eksekusi semua query non-saldo (history & subscription) dalam batch
      await env.DB.batch(ops);
      
      return jsonResponse({ success: true, message: `Berhasil upgrade ke paket ${plan.name}!` });

  } catch(e) {
      return jsonResponse({ error: 'Terjadi kesalahan: ' + e.message }, 500);
  }
}
