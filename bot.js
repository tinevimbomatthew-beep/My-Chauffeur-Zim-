const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal'); // not used for QR, kept for safety

const PHONE_NUMBER = String(process.env.PHONE_NUMBER || '263783264675').replace(/[^0-9]/g, '');
const users = {};

// --- YOUR PRICES ---
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

// --- WHATSAPP WEB.JS - PAIRING CODE ONLY, NO QR, NO BAILEYS ---
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: 'auth_wwebjs' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--single-process', '--disable-gpu']
  }
});

let pairingRequested = false;

client.on('qr', (qr) => {
  // We are NOT using QR - ignore it
  console.log('QR received but ignored - using Pairing Code only');
});

client.on('authenticated', () => {
  console.log('My Chauffeur Zim Bot - AUTHENTICATED!');
});

client.on('ready', () => {
  console.log('My Chauffeur Zim Bot is ready!');
});

client.on('auth_failure', (msg) => {
  console.log('Auth failed:', msg);
});

client.on('disconnected', (reason) => {
  console.log('Disconnected:', reason);
});

// Request Pairing Code once on startup
client.on('loading_screen', async () => {
  if (!pairingRequested) {
    pairingRequested = true;
    try {
      // Wait a bit for client to be ready to pair
      setTimeout(async () => {
        try {
          const code = await client.requestPairingCode(PHONE_NUMBER);
          console.log('======================================');
          console.log('YOUR PAIRING CODE IS:', code);
          console.log('Go to WhatsApp > Linked Devices > Link with phone number');
          console.log('Type this code within 20 seconds');
          console.log('Phone:', PHONE_NUMBER);
          console.log('======================================');
        } catch (e) {
          console.log('Pairing code error:', e.message);
          console.log('If it says already paired, just wait for READY');
        }
      }, 5000);
    } catch (e) {
      console.log('Pairing setup error:', e.message);
    }
  }
});

client.on('message', async (msg) => {
  try {
    if (msg.fromMe) return;
    const from = msg.from;
    const body = (msg.body || '').trim();
    const text = body.toLowerCase();

    if (!users[from]) users[from] = { step: 'menu' };
    const u = users[from];

    const reply = async (txt) => { await client.sendMessage(from, txt); };

    if (text === 'hi' || text === 'hello' || text === 'start' || text === 'menu') {
      u.step = 'menu';
      return await reply(WELCOME);
    }

    if (u.step === 'menu') {
      if (text === '1') { u.step = 'pickup'; return await reply('Let\'s get your price 🚕\n\nWhere should we pick you up?'); }
      if (text === '2') return await reply(PRICES_MSG());
    }

    if (u.step === 'pickup') { u.pickup = body; u.step = 'destination'; return await reply(`Pickup: ${u.pickup}\n\nWhere are you going to?`); }
    if (u.step === 'destination') { u.destination = body; u.step = 'km'; return await reply(`From: ${u.pickup}\nTo: ${u.destination}\n\nHow many kilometers is the trip? Just send the number, e.g. 10`); }
    if (u.step === 'km') {
      const km = parseFloat(text);
      if (isNaN(km)) return await reply('Please send just the number, e.g. 10');
      const c = calc(km);
      u.step = 'menu';
      return await reply(`✅ Your Price - My Chauffeur Zim\n\nFrom: ${u.pickup}\nTo: ${u.destination}\nDistance: ${km}km\n${c.label}\n\nBreakdown:\nFare: ${km}km x $${c.farePerKm.toFixed(2)} = $${c.fare.toFixed(2)}\nDriver Fee: $${c.driverFee.toFixed(2)}\n----------------\nTOTAL: $${c.total.toFixed(2)}\n\nTo book, call / WhatsApp 0783 264 675\n\nType 1 for another price, Type 2 for Prices`);
    }

  } catch (e) { console.log('Message error:', e.message); }
});

console.log('Starting My Chauffeur Zim Bot - WhatsApp Web.js - Pairing Code Only...');
console.log('Phone for pairing:', PHONE_NUMBER);
client.initialize();
