console.log('=== STARTING MY CHAUFFEUR ZIM BOT ===');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const PHONE_NUMBER = (process.env.PHONE_NUMBER || '263783264675').replace(/[^0-9]/g, '');

// --- MIN + MAX RULE ---
function isNight(){ return new Date(new Date().toLocaleString('en-US',{timeZone:'Africa/Harare'})).getHours() >= 20; }
function calcPrice(km, wantMax){
  const night = isNight();
  const MIN = night ? 1.50 : 1.00;
  const MAX = night ? 2.00 : 1.50;
  const perKm = wantMax ? MAX : MIN;
  return { night, MIN, MAX, perKm, total: perKm*km, minimum: MIN*km, maximum: MAX*km };
}
function validateBid(km, total){
  const p = calcPrice(km, false);
  if(total < p.minimum - 0.01) return {ok:false, reason:`Below MIN $${p.minimum.toFixed(2)}`};
  if(total > p.maximum + 0.01) return {ok:false, reason:`Above MAX $${p.maximum.toFixed(2)}`};
  return {ok:true};
}
// Example: driver tries to cheat
// validateBid(10, 5) -> BLOCKED Below MIN $10.00 day / $15.00 night
// validateBid(10, 50) -> BLOCKED Above MAX $15.00 day / $20.00 night
// validateBid(10, 10) -> OK day MIN
// validateBid(10, 15) -> OK day MAX

const sessions = new Map();
const WELCOME = `👋 *Welcome to My Chauffeur Zim!*\n\nType *1* to Book a Ride 🚖\nType *2* for Prices 💰\nType *3* for Support 📞`;
const PRICES = `💰 *Prices - RULE, Cannot Be Broken*\n\nDay: MIN $1.00/km - MAX $1.50/km\nNight (from 8pm): MIN $1.50/km - MAX $2.00/km\n\nExample 10km: Day $10-$15, Night $15-$20\n\nDriver fee is optional. Cheapest driver wins.`;

async function start(){
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, logger: pino({level:'silent'}), auth: state, printQRInTerminal:false, browser:['My Chauffeur Zim','Chrome','1.0'] });
  sock.ev.on('creds.update', saveCreds);
  let pairingInterval=null;
  async function askForCode(){
    if(sock.authState.creds.registered){ if(pairingInterval) clearInterval(pairingInterval); return; }
    try{ const code=await sock.requestPairingCode(PHONE_NUMBER); console.log('===================================='); console.log(`>>> PAIRING CODE: ${code} <<<`); console.log(`For: ${PHONE_NUMBER} - New code every 60s`); console.log('===================================='); }catch(e){ console.log('Pairing failed:', e.message); }
  }
  if(!sock.authState.creds.registered){ setTimeout(askForCode,2000); pairingInterval=setInterval(askForCode,60000); }
  sock.ev.on('connection.update',(u)=>{
    console.log('Connection:', u.connection);
    if(u.connection==='close'){ const r=u.lastDisconnect?.error?.output?.statusCode!==DisconnectReason.loggedOut; if(r) start(); }
    else if(u.connection==='open'){ console.log('✅ Bot LIVE'); if(pairingInterval) clearInterval(pairingInterval); }
  });
  sock.ev.on('messages.upsert', async ({messages})=>{
    const m=messages[0]; if(!m.message||m.key.fromMe) return;
    const from=m.key.remoteJid; const text=(m.message.conversation||m.message.extendedTextMessage?.text||'').trim(); if(!text) return;
    const lower=text.toLowerCase(); let s=sessions.get(from); if(!s){s={step:'menu'};sessions.set(from,s);}
    const send=(t)=>sock.sendMessage(from,{text:t});
    if(lower==='hi'||lower==='hello'||lower==='menu'){s.step='menu';return send(WELCOME);}
    if(s.step==='menu'){
      if(text==='1'){s.step='pickup';return send(`🚖 *Book a Ride*\n\nWhere to pick you up from?`);}
      if(text==='2') return send(PRICES);
      if(text==='3') return send(`📞 Support: +263 78 326 4675\n\nType *hi* for menu`);
      return send(WELCOME);
    }
    if(s.step==='pickup'){s.pickup=text;s.step='dropoff';return send(`Where are you going to?`);}
    if(s.step==='dropoff'){s.dropoff=text;s.step='when';return send(`When? (e.g. Today 2pm)`);}
    if(s.step==='when'){s.when=text;s.step='name';return send(`Your name?`);}
    if(s.step==='name'){
      s.name=text; s.step='waiting';
      // In live version: save to Supabase -> driver site shows it
      return send(`✅ Got it ${s.name}!\n\n${s.pickup} → ${s.dropoff}\nWhen: ${s.when}\n\nPosting to drivers now... Drivers have 3 mins to bid (first 5, cheapest first).\n\nMIN/MAX rule applies. No driver can charge below MIN or above MAX.\n\nWait 3 mins, I will send you the drivers.`);
    }
    if(s.step==='waiting'){
      // Demo: driver bids would come from website. For now, show example
      if(lower==='1'||lower==='2') return send(`You chose driver ${lower}. I will send you their number now.`);
      return send(`Still waiting for drivers... Type *hi* to start again.`);
    }
  });
}
start();
