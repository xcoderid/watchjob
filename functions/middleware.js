import { jsonResponse } from './utils';

export async function onRequest(context) {
  const { request, next } = context;
  
  // Handle Preflight Requests (CORS)
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
    const response = await next();
    // Ensure CORS headers are present on all responses
    response.headers.set('Access-Control-Allow-Origin', '*');
    return response;
  } catch (err) {
    // Global Error Handler
    return jsonResponse({ error: 'Internal Server Error: ' + err.message }, 500);
  }
}
