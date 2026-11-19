// My Chauffeur Zim - Production Bot - Never Die Version
process.on('uncaughtException', (e) => console.log('⚠️ Uncaught, kept alive:', e.message));
process.on('unhandledRejection', (e) => console.log('⚠️ Rejection, kept alive:', e?.message || e));

const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const BOT_NUMBER = process.env.BOT_NUMBER || '263783264675';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.log('❌ MISSING SUPABASE_URL or SUPABASE_ANON_KEY in Railway Variables - bot will still stay alive and retry');
}

const supabase = SUPABASE_URL && SUPABASE_KEY ? createClient(SUPABASE_URL, SUPABASE_KEY) : null;
const PER_KM = 1.50;

let sock = null;
let pairingRequested = false;
let userState = {};
let reconnectAttempts = 0;
let isStarting = false;
let lastPairingAt = 0;
let heartbeatInterval = null;

async function start() {
  if (isStarting) return;
  isStarting = true;
  try {
    console.log(`🚀 Starting bot... attempt ${reconnectAttempts + 1}`);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: [2, 3000, 1015901307] }));
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: ['My Chauffeur Zim', 'Chrome', '1.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 10000,
      retryRequestDelayMs: 2000,
      maxMsgRetryCount: 5,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect } = u;
      console.log('Connection:', connection);

      if (connection === 'open') {
        console.log('✅ CONNECTED - Bot is online');
        pairingRequested = false;
        reconnectAttempts = 0;
        isStarting = false;
        startHeartbeat();
      }

      if (connection === 'close') {
        isStarting = false;
        stopHeartbeat();
        const code = lastDisconnect?.error?.output?.statusCode;
        const reason = lastDisconnect?.error?.message || 'unknown';
        console.log(`Closed, code: ${code}, reason: ${reason}`);

        // 405 = WhatsApp rate limit - WAIT, don't hammer
        if (code === 405) {
          console.log('⏸️ 405 - Rate limited. Sleeping 10 mins, NOT retrying pairing.');
          pairingRequested = true; // block pairing
          setTimeout(() => { pairingRequested = false; console.log('405 cooldown over, can try again'); }, 10 * 60 * 1000);
          // Keep process alive, try reconnect in 10 mins without pairing
          setTimeout(() => safeRestart(), 10 * 60 * 1000);
          return;
        }

        if (code === DisconnectReason.loggedOut) {
          console.log('Logged out - delete auth_baileys in Railway Volume and re-pair once');
          // Stay alive, don't crash loop
          setTimeout(() => safeRestart(), 60000);
          return;
        }

        // Normal disconnect - exponential backoff, max 60s
        reconnectAttempts++;
        const delay = Math.min(5000 * reconnectAttempts, 60000);
        console.log(`Reconnecting in ${delay/1000}s...`);
        setTimeout(() => safeRestart(), delay);
      }

      // Pairing - ONLY ONCE per 5 mins, NEVER loop
      if (!state.creds.registered && !pairingRequested) {
        const now = Date.now();
        if (now - lastPairingAt < 5 * 60 * 1000) {
          console.log('Pairing cooldown, skipping');
          return;
        }
        pairingRequested = true;
        lastPairingAt = now;
        await new Promise(r => setTimeout(r, 4000));
        try {
          const code = await sock.requestPairingCode(BOT_NUMBER);
          console.log('====================================');
          console.log('PAIRING CODE:', code);
          console.log('WhatsApp > Linked Devices > Link with phone number');
          console.log('You have 20 seconds!');
          console.log('====================================');
          // Allow retry after 60s if it fails, but not immediate loop
          setTimeout(() => { pairingRequested = false; }, 60000);
        } catch (e) {
          console.log('Pairing error:', e.message);
          setTimeout(() => { pairingRequested = false; }, 60000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
      try {
        for (const m of messages) {
          if (!m.message || m.key.fromMe) continue;
          const from = m.key.remoteJid?.replace('@s.whatsapp.net', '');
          if (!from) continue;
          const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || '';
          if (!text) continue;
          await handleMessage(from, text.trim());
        }
      } catch (e) { console.log('Message handler error, kept alive:', e.message); }
    });

    sock.ev.on('messages.update', () => {});
    isStarting = false;

  } catch (e) {
    console.log('Start error, will retry in 10s:', e.message);
    isStarting = false;
    setTimeout(() => safeRestart(), 10000);
  }
}

function safeRestart() {
  try { if (sock) sock.end?.(); } catch {}
  sock = null;
  isStarting = false;
  start();
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    console.log(`💓 Heartbeat - alive ${new Date().toISOString()} - reconnectAttempts: ${reconnectAttempts}`);
    // Keep Railway alive, prevent idle kill
    if (sock) {
      try { sock.sendPresenceUpdate?.('available'); } catch {}
    }
  }, 30000);
  // Poll website bookings every 15s inside heartbeat loop
  setInterval(checkWebsiteBookings, 15000);
}

function stopHeartbeat() {
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  heartbeatInterval = null;
}

async function handleMessage(from, text) {
  try {
    const lower = text.toLowerCase();
    const st = userState[from] || { step: 'start' };

    if (['hi','hello','menu','start','hey'].includes(lower)) {
      st.step = 'pickup'; userState[from] = st;
      await send(from, `🚕 *My Chauffeur Zim*\n\nWelcome! Let's book your ride.\n\nPrice: $1.50 per km ($1.00/km + $0.50 fee)\n\nWhere is your *pickup*? e.g. Bulawayo CBD`);
      return;
    }
    if (st.step === 'pickup') {
      st.pickup = text; st.step = 'destination'; userState[from] = st;
      await send(from, `Pickup: ${text}\n\nWhere is your *destination*?`);
      return;
    }
    if (st.step === 'destination') {
      st.destination = text; st.step = 'km'; userState[from] = st;
      await send(from, `Destination: ${text}\n\nHow many *km*? Send a number e.g. 10`);
      return;
    }
    if (st.step === 'km') {
      const km = parseFloat(text);
      if (!km) { await send(from, `Please send a number for km, e.g. 10`); return; }
      const total = (km * PER_KM).toFixed(2);
      st.km = km; st.total = total; st.step = 'confirm'; userState[from] = st;
      await send(from, `📋 *Confirm Booking*\n\nFrom: ${st.pickup}\nTo: ${st.destination}\nDistance: ${km}km\nTotal: $${total}\n\nReply *YES* to confirm, or *NO* to cancel.`);
      return;
    }
    if (st.step === 'confirm' && lower === 'yes') {
      if (!supabase) { await send(from, `System busy, try again in a minute.`); return; }
      const { data, error } = await supabase.from('bookings').insert([{
        customer_name: from, phone: from, pickup: st.pickup, destination: st.destination,
        city: 'Bulawayo', distance_km: st.km, price: st.total,
        status: 'pending', source: 'whatsapp', whatsapp_sent: true
      }]).select().single();
      if (error) { await send(from, `Error saving: ${error.message}`); return; }
      delete userState[from];
      await send(from, `✅ Booking saved! ID: ${data.id}\n\n${st.pickup} → ${st.destination}\n${st.km}km = $${st.total}\n\nA driver will contact you soon.`);
      await send(BOT_NUMBER, `🚕 NEW WHATSAPP BOOKING #${data.id}\n${st.pickup} → ${st.destination}\n${st.km}km = $${st.total}\nCustomer: ${from}`);
      return;
    }
    if (lower === 'no' && st.step === 'confirm') {
      delete userState[from];
      await send(from, `Cancelled. Send *HI* to start again.`);
      return;
    }
    await send(from, `Send *HI* to book a ride 🚕`);
  } catch (e) { console.log('handleMessage error:', e.message); }
}

async function send(to, text) {
  try {
    if (!sock) return;
    const jid = to.includes('@') ? to : to + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text });
  } catch (e) { console.log('Send error (not fatal):', e.message); }
}

async function checkWebsiteBookings() {
  try {
    if (!sock || !supabase) return;
    const { data, error } = await supabase.from('bookings').select('*').eq('source', 'website').eq('whatsapp_sent', false).eq('status', 'pending');
    if (error || !data?.length) return;
    for (const b of data) {
      await send(BOT_NUMBER, `🌐 *NEW WEBSITE BOOKING #${b.id}*\n\n👤 ${b.customer_name} - ${b.phone}\n📍 ${b.pickup} → ${b.destination}\n🏙️ ${b.city}\n📏 ${b.distance_km}km = $${b.price}`);
      await send(b.phone, `✅ *My Chauffeur Zim* - Booking #${b.id} received!\n\n${b.pickup} → ${b.destination}\n${b.distance_km}km = $${b.price}\n\nA driver will WhatsApp you shortly.`);
      await supabase.from('bookings').update({ whatsapp_sent: true }).eq('id', b.id);
      console.log('Website booking notified:', b.id);
    }
  } catch (e) { console.log('checkWebsiteBookings error:', e.message); }
}

// Keep process alive even if Railway sends SIGTERM
process.on('SIGTERM', () => { console.log('SIGTERM received, staying alive...'); });
process.on('SIGINT', () => { console.log('SIGINT received, staying alive...'); });

// Health check - Railway needs a port or it kills you. This keeps it alive.
const http = require('http');
http.createServer((req, res) => { res.writeHead(200); res.end('Bot alive - ' + new Date().toISOString()); }).listen(process.env.PORT || 3000, () => console.log('Health server on', process.env.PORT || 3000));

console.log('Starting My Chauffeur Zim bot...');
start();

// Self-watchdog: if socket dies silently, restart it
setInterval(() => {
  if (!sock && !isStarting) {
    console.log('Watchdog: socket missing, restarting...');
    safeRestart();
  }
}, 60000);
