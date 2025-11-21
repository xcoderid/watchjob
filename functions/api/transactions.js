import { jsonResponse, authenticateUser, updateUserBalance } from '../utils';

/**
 * HANDLE GET REQUEST (Mengambil daftar transaksi user)
 */
export async function onRequestGet(context) {
  const { request, env } = context;
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  try {
    const transactions = await env.DB.prepare(`
        SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 50
    `).bind(user.id).all();
    
    return jsonResponse(transactions.results);
  } catch (e) {
    return jsonResponse({ error: 'Error: ' + e.message }, 500);
  }
}

/**
 * HANDLE POST REQUEST (Deposit atau Withdrawal)
 */
export async function onRequestPost(context) {
  const { request, env } = context;
  const user = await authenticateUser(env, request);
  if (!user) return jsonResponse({ error: 'Unauthorized' }, 401);

  const body = await request.json();
  const { type, amount, method } = body; 
  const userId = user.id;

  if (!amount || amount <= 0) return jsonResponse({ error: 'Jumlah harus > 0' }, 400);
  
  const numericAmount = parseFloat(amount);
  
  // --- LOGIKA WITHDRAWAL ---
  if (type === 'withdrawal') {
     // Cek Saldo: Diambil langsung dari kolom users.balance
     if (user.balance < numericAmount) {
         return jsonResponse({ error: 'Saldo tidak mencukupi.' }, 400);
     }
     // Cek Data Bank
     if (!user.account_number || !user.account_name) {
         return jsonResponse({ error: 'Data bank belum lengkap di profil.' }, 400);
     }
  }

  try {
    let desc, status;
    let balanceChange = 0;

    if (type === 'deposit') {
        desc = `Deposit via ${method}`;
        status = 'pending'; // Deposit selalu pending, perlu approval Admin
        // TIDAK ada perubahan saldo users.balance saat deposit, perubahan terjadi saat Admin approve.
    
    } else if (type === 'withdrawal') {
        desc = `Withdraw ke ${user.bank_name} - ${user.account_number}`;
        status = 'pending'; 
        balanceChange = -numericAmount; // Saldo langsung dikurangi saat pengajuan WD

    } else {
        return jsonResponse({ error: 'Tipe transaksi tidak valid.' }, 400);
    }
    
    // 1. Catat Transaksi
    const tx = await env.DB.prepare(`
        INSERT INTO transactions (user_id, type, amount, description, status) 
        VALUES (?, ?, ?, ?, ?)
    `).bind(userId, type, numericAmount, desc, status).run();

    // 2. KRITIS: Update Saldo di kolom users.balance (Hanya untuk WD)
    if (balanceChange !== 0) {
        await updateUserBalance(env, userId, balanceChange);
    }

    return jsonResponse({ success: true, message: `${type} berhasil diajukan.` });

  } catch (e) {
    // Tangkap error dari updateUserBalance juga
    return jsonResponse({ error: 'Error sistem: ' + e.message }, 500);
  }
}
