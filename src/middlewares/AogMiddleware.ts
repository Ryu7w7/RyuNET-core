import { RequestHandler } from 'express';
import { Logger } from '../utils/Logger';
import { getAogHandler, getAogFallback } from '../aog/AogRegistry';

function parseForm(body: Buffer): Record<string, string> {
  const text = body.toString('utf-8');
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function gameApiName(path: string): string {
  let p = path.split('?')[0].replace(/^\/+/, '');
  if (p.startsWith('aog/')) p = p.slice(4);
  p = p.split('/').pop() || '';
  return p.trim();
}

const KNOWN_AOG = new Set([
  "appli_boot","appli_info","login","logout","create_player","get_menudata","keep_alive",
  "client_state_read","client_state_write","entry_game","gget","gpost","end_game","kiken_game","end_show","reconnect",
  "chk_tabooword","dojo_get_status","dojo_set_slot","dojo_gain_soul","gacha_info","gacha_log","req_draw_gacha","get_gacha_result",
  "music_gacha_play","music_gacha_play_reserve","gchat","gget_stamp_info","player_record","get_record","get_haifu_list","get_haifu_data",
  "get_jongstone_info","get_mg","mission_date","present_done","competition_entry","item_gain_log","item_consume_log","notice_done","important_notice_done","set_favorite_character","odekake_done","coop_done","eashop_done"
]);

export const AogMiddleware: RequestHandler = async (req, res, next) => {
  const url: string = (req as any).originalUrl || req.url || '';
  const method = (req.method || '').toUpperCase();
  const agent = String(req.headers['user-agent'] || '');
  // Browser (WebUI) must never be treated as AOG
  if (agent.includes('Mozilla')) return next();
  // XRPC has x-eamuse-info / x-compress, never treat as AOG
  if (req.headers['x-eamuse-info'] || req.headers['x-compress']) return next();
  const nameProbe = gameApiName(url);
  const isAogPath = url.startsWith('/aog') || KNOWN_AOG.has(nameProbe);
  if (!isAogPath) return next();
  if (method === 'GET' && !isAogPath) return next();

  // Collect body
  const chunks: Buffer[] = [];
  req.on('data', (c) => chunks.push(Buffer.from(c)));
  req.on('end', async () => {
    try {
      const bodyBuf = Buffer.concat(chunks);
      const form = bodyBuf.length ? parseForm(bodyBuf) : {};

      // Also merge query string (pcuid etc may be in query? but usually body)
      try {
        const u = new URL(req.originalUrl, `http://${req.headers.host || 'localhost'}`);
        for (const [k, v] of u.searchParams.entries()) {
          if (!(k in form)) form[k] = v;
        }
      } catch {}

      const name = gameApiName(url);
      Logger.info(`[AOG] /${name} keys=${Object.keys(form).join(',')}`, { plugin: 'mfg@asphyxia' });

      const handler = getAogHandler(name);
      if (handler) {
        await handler(form as any, { req, res, form, name, url });
        return;
      }
      const fb = getAogFallback();
      if (fb) {
        // fallback may be (form,ctx) or (ctx) - try both
        try {
          await (fb as any)(form as any, { req, res, form, name, url } as any);
        } catch {
          await (fb as any)({ req, res, form, name, url } as any);
        }
        return;
      }
      Logger.warn(`[AOG] unhandled ${name || url} — empty success`, { plugin: 'mfg@asphyxia' });
      // default empty success xml
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<root><serv_st><code>0</code></serv_st></root>`;
      res.set('Content-Type', 'text/xml; charset=utf-8');
      res.send(xml);
    } catch (e) {
      Logger.error(`[AOG] handler crashed for ${url}: ${e}`, { plugin: 'mfg@asphyxia' });
      const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<root><serv_st><code>0</code></serv_st></root>`;
      res.set('Content-Type', 'text/xml; charset=utf-8');
      res.send(xml);
    }
  });
  // Do not call next(); we handle response in 'end' event
};

// Health / keepalive helpers for GET
export const AogGetMiddleware: RequestHandler = (req, res, next) => {
  const url = req.originalUrl || req.url || '';
  const agent = String(req.headers['user-agent'] || '');
  const isBrowser = agent.includes('Mozilla');
  if (req.method === 'GET') {
    // Don't hijack browser WebUI: let WebUI handle GET /
    if (url === '/' && isBrowser) return next();
    if (url === '/' || url === '/health' || url === '/status') {
      // Only respond with VFG ok for non-browser (game) health checks
      if (isBrowser) return next();
      res.set('Content-Type', 'text/plain; charset=utf-8');
      res.send(`VFG local server ok via RyuNET\n`);
      return;
    }
    if (url.startsWith('/core/keepalive')) {
      res.set('Content-Type', 'text/plain');
      res.send('ok');
      return;
    }
  }
  next();
};
