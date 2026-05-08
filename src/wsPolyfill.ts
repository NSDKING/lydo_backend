import ws from 'ws';

// 👇 This makes Supabase think WebSocket exists natively
(global as any).WebSocket = ws;