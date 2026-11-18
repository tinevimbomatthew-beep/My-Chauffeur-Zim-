global.WebSocket = require('ws');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '').replace(/[^0-9]/g, '');
const users = {};

// --- YOUR NEW PRICES ---
function getPrices() {
  const hour = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Harare' })).getHours();
  const isNight = hour >= 20 || hour < 6; // 8pm to 6am
  if (isNight) {
    return { isNight: true, label: '🌙 NIGHT (8pm - 6am)', farePerKm: 0.75, driverFee: 0.75 };
  }
  return { isNight: false, label: '☀️ DAY (6am - 8pm)', farePerKm: 0.50, driverFee: 0.50 };
}

function calc(km) {
  const p = getPrices();
  const fare = km * p.farePerKm;
  const total = fare + p.driverFee;
  return { ...p, fare, total };
}

const WELCOME = `👋 Welcome to My Chauffeur Zim!

Type 1 to Get Price 🚕
Type 2 for Prices 💰`;

const PRICES_MSG = () => {
  const p = getPrices();
  return `💰 My Chauffeur Zim Prices

${p.label} - RIGHT NOW

DAY (6am - 8pm):
Fare: $0.50 per km
Driver Fee: $0.50
Example 10km = $5.50

NIGHT (8pm - 6am):
Fare: $0.75 per km
Driver Fee: $0.75
Example 10km = $8.25

Night starts at 8pm and ends at 6am, then we go back to Day price automatically.

Type 1 to Get Price`;
};

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }),
    browser: ['My Chauffeur Zim', 'Chrome', '1.0.0']
  });

  sock.ev.on('creds.update', saveCreds);

  let codeRequested = false;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr && !sock.authState.creds.registered) {
      console.log('=== SCAN THIS QR ===');
      qrcode.generate(qr, { small: true });
      if (!codeRequested) {
        codeRequested = true;
        setTimeout(async () => {
          try {
            const code = await sock.requestPairingCode(PHONE_NUMBER);
            console.log('YOUR PAIRING CODE IS:', code);
          } catch (e) { console.log('Pairing error, use QR:', e.message); }
        }, 3000);
      }
    }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('Connection closed, reconnecting:', shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === 'open') {
      console.log('My Chauffeur Zim Bot is ready!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    try {
      const msg = messages[0];
      if (!msg.message || msg.key.fromMe) return;
      const from = msg.key.remoteJid;
      const body = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
      const text = body.trim().toLowerCase();
      const reply = async (txt) => { await sock.sendMessage(from, { text: txt }); };

      if (!users[from]) users[from] = { step: 'menu' };
      const u = users[from];

      if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu') {
        u.step = 'menu';
        return await reply(WELCOME);
      }

      if (u.step === 'menu') {
        if (text === '1') { u.step = 'pickup'; return await reply('Let\'s get your price 🚕\n\nWhere should we pick you up?'); }
        if (text === '2') return await reply(PRICES_MSG());
      }

      if (u.step === 'pickup') { u.pickup = body.trim(); u.step = 'destination'; return await reply(`Pickup: ${u.pickup}\n\nWhere are you going to?`); }
      if (u.step === 'destination') { u.destination = body.trim(); u.step = 'km'; return await reply(`From: ${u.pickup}\nTo: ${u.destination}\n\nHow many kilometers is the trip? Just send the number, e.g. 10`); }
      if (u.step === 'km') {
        const km = parseFloat(text);
        if (isNaN(km)) return await reply('Please send just the number, e.g. 10');
        const c = calc(km);
        u.step = 'menu';
        return await reply(`✅ Your Price - My Chauffeur Zim\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nDistance: ${km}km\n${c.label}\n\nBreakdown:\nFare: ${km}km x $${c.farePerKm.toFixed(2)} = $${c.fare.toFixed(2)}\nDriver Fee: $${c.driverFee.toFixed(2)}\n----------------\nTOTAL: $${c.total.toFixed(2)}\n\nTo book, call / WhatsApp 0783 264 675\n\nType 1 for another price, Type 2 for Prices`);
      }

    } catch (e) { console.log('Message error:', e.message); }
  });
}

console.log('Starting My Chauffeur Zim Bot...');
startBot();
