// functions/_middleware.js

// Helper untuk response JSON standar
const jsonResponse = (data, status = 200) => {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*', // Izinkan semua domain (untuk dev)
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
};

// Middleware utama
export async function onRequest(context) {
  const { request, next } = context;

  // Handle Preflight Request (CORS) untuk method OPTIONS
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  try {
    // Lanjutkan ke fungsi API yang sebenarnya
    const response = await next();
    
    // Tambahkan header CORS ke response asli
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  } catch (err) {
    // Global Error Handler
    return jsonResponse({ error: err.message, stack: err.stack }, 500);
  }
}
