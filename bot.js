console.log('=== STARTING MY CHAUFFEUR ZIM - WHATSAPP WEB JS ===');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const PHONE = (process.env.PHONE_NUMBER || '263783264675').replace(/[^0-9]/g, '');
console.log('Business number for pairing:', PHONE);

// --- MIN + MAX RULE ---
function isNight(){ return new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Harare'})).getHours() >= 20; }
function calcPrice(km, wantMax){
  const night = isNight();
  const MIN = night ? 1.50 : 1.00;
  const MAX = night ? 2.00 : 1.50;
  const perKm = wantMax ? MAX : MIN;
  return { night, MIN, MAX, perKm, total: perKm*km, minimum: MIN*km, maximum: MAX*km };
}

const sessions = new Map();
const WELCOME = `👋 *Welcome to My Chauffeur Zim!*\n\nType *1* to Book a Ride 🚖\nType *2* for Prices 💰\nType *3* for Support 📞`;
const PRICES = `💰 *Prices - RULE, Cannot Be Broken*\n\nDay: MIN $1.00/km - MAX $1.50/km\nNight (from 8pm): MIN $1.50/km - MAX $2.00/km\n\nExample 10km: Day $10-$15, Night $15-$20\n\nDriver fee optional. Cheapest driver wins.`;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: 'auth' }),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
  }
});

// QR as backup if you want to scan
client.on('qr', (qr) => {
  console.log('=== SCAN THIS QR IN WHATSAPP BUSINESS > LINKED DEVICES ===');
  qrcode.generate(qr, { small: true });
});

// *** PAIRING CODE - EVERY 60 SECONDS ***
let pairingDone = false;
async function askPairingCode(){
  if(pairingDone) return;
  try{
    const code = await client.requestPairingCode(PHONE);
    console.log('====================================');
    console.log(`>>> PAIRING CODE: ${code} <<<`);
    console.log(`For Business number: ${PHONE}`);
    console.log('Go to WhatsApp Business > Linked Devices > Link with phone number > Enter code');
    console.log('New code in 60 seconds if you dont use this one...');
    console.log('====================================');
  }catch(e){ console.log('Pairing failed, will retry:', e.message); }
}

client.on('ready', () => {
  pairingDone = true;
  console.log('✅ Bot LIVE - Locked to WhatsApp Business!');
});

client.on('auth_failure', (m) => console.log('Auth failed:', m));
client.on('disconnected', (r) => console.log('Disconnected:', r));

client.on('message', async (msg) => {
  if(msg.fromMe) return;
  const from = msg.from;
  const text = msg.body.trim();
  if(!text) return;
  const lower = text.toLowerCase();
  let s = sessions.get(from); if(!s){ s={step:'menu'}; sessions.set(from,s); }
  const send = (t) => client.sendMessage(from, t);

  if(lower==='hi'||lower==='hello'||lower==='menu'){ s.step='menu'; return send(WELCOME); }
  if(s.step==='menu'){
    if(text==='1'){ s.step='pickup'; return send(`🚖 *Book a Ride*\n\nWhere should we pick you up from?`); }
    if(text==='2') return send(PRICES);
    if(text==='3') return send(`📞 Support: +263 78 326 4675\n\nType *hi* for menu`);
    return send(WELCOME);
  }
  if(s.step==='pickup'){ s.pickup=text; s.step='dropoff'; return send(`Where are you going to?`); }
  if(s.step==='dropoff'){ s.dropoff=text; s.step='when'; return send(`When? (e.g. Today 2pm)`); }
  if(s.step==='when'){ s.when=text; s.step='name'; return send(`Your name?`); }
  if(s.step==='name'){
    s.name=text; s.step='waiting';
    console.log('NEW RIDE FOR DRIVERS:', s);
    return send(`✅ Got it ${s.name}!\n\n${s.pickup} → ${s.dropoff}\nWhen: ${s.when}\n\nPosting to drivers now... Drivers have 3 mins to bid (first 5, cheapest first).\n\nMIN/MAX rule applies. No driver can charge below MIN or above MAX.\n\nWait 3 mins, I will send you the drivers.`);
  }
});

client.initialize().then(() => {
  console.log('Client initializing, requesting pairing code in 3s...');
  setTimeout(askPairingCode, 3000);
  setInterval(askPairingCode, 60000); // new code every 60s
});
