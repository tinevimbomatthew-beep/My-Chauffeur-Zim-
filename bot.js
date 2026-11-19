const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const pino = require('pino');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const BOT_NUMBER = '263783264675';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const PER_KM = 1.50;

let sock;
let pairingRequested = false;
let userState = {};

async function start() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    browser: ['My Chauffeur Zim', 'Chrome', '1.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect } = u;

    if (connection === 'open') {
      console.log('✅ CONNECTED - Bot is online');
      pairingRequested = false;
    }

    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log('Connection closed, code:', code);
      if (code === 405) {
        console.log('405 - Pairing blocked. STOP. Wait 10 mins, delete auth, try once.');
        return;
      }
      if (code === DisconnectReason.loggedOut) {
        console.log('Logged out - need re-pair');
        return;
      }
      console.log('Reconnecting in 5s...');
      setTimeout(start, 5000);
    }

    if (!state.creds.registered && !pairingRequested) {
      pairingRequested = true;
      await new Promise(r => setTimeout(r, 4000));
      try {
        const code = await sock.requestPairingCode(BOT_NUMBER);
        console.log('====================================');
        console.log('PAIRING CODE:', code);
        console.log('WhatsApp > Linked Devices > Link with phone number');
        console.log('You have 20 seconds!');
        console.log('====================================');
      } catch (e) {
        console.log('Pairing error:', e.message);
        pairingRequested = false;
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      if (!m.message || m.key.fromMe) continue;
      const from = m.key.remoteJid.replace('@s.whatsapp.net', '');
      const text = m.message.conversation || m.message.extendedTextMessage?.text || '';
      if (!text) continue;
      await handleMessage(from, text.trim());
    }
  });

  setInterval(checkWebsiteBookings, 15000);
}

async function handleMessage(from, text) {
  const lower = text.toLowerCase();
  const st = userState[from] || { step: 'start' };

  if (lower === 'hi' || lower === 'hello' || lower === 'menu' || lower === 'start') {
    st.step = 'pickup';
    userState[from] = st;
    await send(from, `🚕 *My Chauffeur Zim*\n\nWelcome! Let's book your ride.\n\nPrice: $1.50 per km ($1.00/km + $0.50 fee)\n\nWhere is your *pickup*? Send location name e.g. Bulawayo CBD`);
    return;
  }

  if (st.step === 'pickup') {
    st.pickup = text; st.step = 'destination';
    userState[from] = st;
    await send(from, `Pickup: ${text}\n\nWhere is your *destination*?`);
    return;
  }

  if (st.step === 'destination') {
    st.destination = text; st.step = 'km';
    userState[from] = st;
    await send(from, `Destination: ${text}\n\nHow many *km*? Send a number e.g. 10`);
    return;
  }

  if (st.step === 'km') {
    const km = parseFloat(text);
    if (!km) { await send(from, `Please send a number for km, e.g. 10`); return; }
    const total = (km * PER_KM).toFixed(2);
    st.km = km; st.total = total; st.step = 'confirm';
    userState[from] = st;
    await send(from, `📋 *Confirm Booking*\n\nFrom: ${st.pickup}\nTo: ${st.destination}\nDistance: ${km}km\nTotal: $${total}\n\nReply *YES* to confirm, or *NO* to cancel.`);
    return;
  }

  if (st.step === 'confirm' && lower === 'yes') {
    const { data, error } = await supabase.from('bookings').insert([{
      customer_name: from,
      phone: from,
      pickup: st.pickup,
      destination: st.destination,
      city: 'Bulawayo',
      distance_km: st.km,
      price: st.total,
      status: 'pending',
      source: 'whatsapp',
      whatsapp_sent: true
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
}

async function send(to, text) {
  try {
    const jid = to.includes('@') ? to : to + '@s.whatsapp.net';
    await sock.sendMessage(jid, { text });
  } catch (e) { console.log('Send error:', e.message); }
}

async function checkWebsiteBookings() {
  if (!sock) return;
  const { data } = await supabase.from('bookings')
    .select('*')
    .eq('source', 'website')
    .eq('whatsapp_sent', false)
    .eq('status', 'pending');

  if (!data || !data.length) return;

  for (const b of data) {
    const msg = `🌐 *NEW WEBSITE BOOKING #${b.id}*\n\n👤 ${b.customer_name} - ${b.phone}\n📍 ${b.pickup} → ${b.destination}\n🏙️ ${b.city}\n📏 ${b.distance_km}km = $${b.price}\n\nReply to customer on ${b.phone}`;
    await send(BOT_NUMBER, msg);
    await send(b.phone, `✅ *My Chauffeur Zim* - Booking #${b.id} received!\n\n${b.pickup} → ${b.destination}\n${b.distance_km}km = $${b.price}\n\nA driver will WhatsApp you shortly.`);
    await supabase.from('bookings').update({ whatsapp_sent: true }).eq('id', b.id);
    console.log('Website booking notified:', b.id);
  }
}

start();
