export { CloudflareRoom } from './cloudflare-room.js';

const roomPath = /^\/room\/([a-z2-7]{10})$/;
const privateHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' };

function error(status: number, message: string): Response {
  return Response.json({ error: message }, { status, headers: privateHeaders });
}

export default {
  async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return new Response('ok', { headers: privateHeaders });
    const roomId = roomPath.exec(url.pathname)?.[1];
    if (roomId) {
      if (request.method !== 'GET' || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket')
        return error(426, 'WebSocket required');
      // Native clients may omit Origin; browsers must use the deployed app.
      const origin = request.headers.get('Origin');
      if (origin !== null && origin !== env.APP_ORIGIN) return error(403, 'Origin not allowed');
      const { success } = await env.CONNECTION_LIMIT.limit({
        key: request.headers.get('CF-Connecting-IP') ?? 'unknown',
      });
      if (!success) return error(429, 'Too many connections');
      return env.ROOMS.getByName(roomId).fetch(request);
    }
    // TURN egress is metered without a verified provider-enforced spending cap.
    // This deployment must never issue billable relay credentials.
    if (url.pathname === '/api/turn') return error(503, 'Relay disabled: free-only hosting');
    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/room/'))
      return error(404, 'Not found');
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
