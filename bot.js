const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal');

const supabase = createClient("https://mogkiebjvlifeybvsoe.supabase.co", "sb_publishable_Ahk3owY4S6SWC7klW9ArRw_TaQIho5f");

let activeRides = new Map();

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState('auth');
  const sock = makeWASocket({ auth: state });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', (u) => {
    if (u.qr) qrcode.generate(u.qr, { small: true });
    if (u.connection === 'open') console.log("My Chauffeur Bot Connected!");
  });
  const reply = (to, text) => sock.sendMessage(to, { text });
  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;
    const from = m.key.remoteJid;
    const text = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
    const lower = text.toLowerCase();
    if (/^[1-9]$/.test(text) && activeRides.has(from + "_offers")) {
      const offers = activeRides.get(from + "_offers");
      const chosen = offers[Number(text) - 1];
      if (!chosen) return reply(from, "Invalid number, try again");
      const rideId = activeRides.get(from);
      await supabase.from('rides').update({ status: 'accepted', driver_phone: chosen.driver_phone }).eq('id', rideId);
      await reply(from, `✅ You picked ${chosen.driver_name} - $${chosen.fee}\nHe is ${chosen.eta_mins} mins away. He will call you now.`);
      await sock.sendMessage(chosen.driver_phone.replace('+','') + "@s.whatsapp.net", { text: `🎉 YOU GOT THE RIDE!\nRider: ${from}\nFee: $${chosen.fee}\nCall rider now!` });
      return;
    }
    if (lower.includes(" to ") || lower.includes("->")) {
      let clean = text.replace(/i want a ride/i, '').trim();
      let parts = clean.split(/ to |->/);
      if (parts.length < 2) return;
      let pickup = parts[0].trim(), dropoff = parts[1].trim();
      const { data: ride } = await supabase.from('rides').insert([{ customer_phone: from, pickup, dropoff, status: 'waiting' }]).select().single();
      activeRides.set(from, ride.id);
      await reply(from, `✅ Got it!\n\n${pickup} → ${dropoff}\n\nPosting to drivers now... Waiting 60 seconds for drivers near you to bid.`);
      setTimeout(async () => {
        const { data: offers } = await supabase.from('offers').select('*').eq('ride_id', ride.id).order('fee', { ascending: true });
        if (!offers || !offers.length) { await reply(from, `No drivers found near ${pickup} right now. A driver will call you shortly.`); return; }
        let msg = `🚖 Found ${offers.length} drivers near you:\n\n`;
        offers.forEach((o, i) => { msg += `${i+1}. ${o.driver_name} - $${o.fee} - ${o.eta_mins} mins away\n`; });
        msg += `\nReply with the number 1, 2 or 3 to pick your driver.`;
        activeRides.set(from + "_offers", offers);
        await reply(from, msg);
      }, 60000);
      return;
    }
    if (lower === "hi" || lower === "hello") {
      await reply(from, `Welcome to My Chauffeur Zim 🇿🇼\n\nTo book, just type:\nHillside to CBD\n\nOr: Kwekwe to Harare\n\nWe will find drivers in 60 seconds.`);
    }
  });
}
start();
