global.WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Railway / Render fix: use /usr/bin/chromium if it exists, otherwise use bundled puppeteer
let chromePath = process.env.CHROME_PATH;
if (!chromePath && fs.existsSync('/usr/bin/chromium')) chromePath = '/usr/bin/chromium';
if (!chromePath && fs.existsSync('/usr/bin/chromium-browser')) chromePath = '/usr/bin/chromium-browser';

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    ...(chromePath ? { executablePath: chromePath } : {}),
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--single-process']
  }
});

// === PAIRING CODE FIX - Request inside QR event, NOT after initialize() ===
let pairingRequested = false;

client.on('qr', async (qr) => {
  console.log('QR event fired - requesting pairing code instead...');
  if (pairingRequested) return;
  pairingRequested = true;

  const phone = process.env.PHONE_NUMBER;
  console.log('Using phone for pairing:', phone);

  if (!phone) {
    console.log('ERROR: PHONE_NUMBER env var is missing in Railway!');
    pairingRequested = false;
    return;
  }

  try {
    await new Promise(r => setTimeout(r, 2000));
    const code = await client.requestPairingCode(phone);
    console.log('====================================');
    console.log('YOUR PAIRING CODE IS: ' + code);
    console.log('Go to WhatsApp > Linked devices > Link with phone number');
    console.log('Enter this code: ' + code);
    console.log('====================================');
  } catch (e) {
    console.log('Pairing code error FULL:', e);
    pairingRequested = false;
  }
});

client.on('code', (code) => {
  console.log('====================================');
  console.log('YOUR PAIRING CODE IS: ' + code);
  console.log('Go to WhatsApp > Linked devices > Link with phone number');
  console.log('Enter this code: ' + code);
  console.log('====================================');
});

client.on('ready', () => { console.log('My Chauffeur Zim Bot is ready!'); });
client.on('auth_failure', (msg) => { console.log('Auth failed:', msg); });
client.on('disconnected', (reason) => { console.log('Disconnected:', reason); });

// === FINAL PRICING: $1.50 per km, driver adds fee, keeps ALL ===
function calcFare(km){
  if(!km || km < 1) km = 1;
  return km * 1.50;
}
function calcFee(km, rideType){
  let type = (rideType || '').toLowerCase();
  if(type.includes('outside') || type.includes('airport') || km >= 15) return 1.00;
  return 0.50;
}
function calcTotal(km, rideType){
  return calcFare(km) + calcFee(km, rideType);
}

const userState = {};
const MAIN_MENU = `👋 *Welcome to My Chauffeur Zim!*\n\n` +
  `How can we help you today?\n\n` +
  `Type *1* to Book a Ride 🚖\n` +
  `Type *2* for Prices 💰\n` +
  `Type *3* for Support 📞`;

client.on('message', async (msg) => {
  try {
    const from = msg.from;
    const text = msg.body.trim().toLowerCase();
    const raw =
