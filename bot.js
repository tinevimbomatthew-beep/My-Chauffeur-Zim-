// My Chauffeur Zim - WhatsApp Bot connected to Website via Supabase
// Number: 0783264675
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  "https://mogkiebjvlifeybvsoe.supabase.co",
  "sb_publishable_Ahk3owY4S6SWC7klW9ArRw_TaQIho5f"
);

const client = new Client({ authStrategy: new LocalAuth(), puppeteer: { args: ['--no-sandbox','--disable-setuid-sandbox'] } });
client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('SCAN WITH 0783264675'); });
client.on('ready', () => console.log('✅ BOT ONLINE - 0783264675 - Connected to website'));

// Memory: what step is each rider on?
const sessions = {}; // phone -> { step, name, pickup, dropoff, time, rideId, bids:[] }
const driverSessions = {}; // driver phone -> { biddingRideId }

client.on('message', async msg => {
  if (msg.fromMe) return;
  const phone = msg.from.replace('@c.us','');
  const text = msg.body.trim();
  const lower = text.toLowerCase();

  // --- DRIVER BIDDING ---
  // Driver replies: BID 7 for ride 123 OR just "7"
  if (lower.startsWith('bid')) {
    const price = text.replace(/[^0-9.]/g,'');
    const ds = driverSessions[phone];
    if (ds && ds.rideId) {
      await supabase.from('bids').insert([{ ride_id: ds.rideId, driver_phone: phone, price: parseFloat(price), status: 'pending' }]);
      await msg.reply(`✅ Your bid $${price} sent to rider. Wait for rider to pick you.`);
      // Notify rider with updated list
      await sendBidsToRider(ds.rideId);
    } else {
      await msg.reply(`To BID, go to driver page and tap BID, or reply: BID 7`);
    }
    return;
  }

  // --- RIDER FLOW ---
  let s = sessions[phone];
  if (!s) {
    // New rider
    if (lower.includes('hi') || lower.includes('ride') || lower.includes('hello')) {
      sessions[phone] = { step: 'ask_trip' };
      await msg.reply(`Welcome to My Chauffeur Zim 🇿🇼\n\nWhere do you want to go? Type like this:\nHillside to CBD`);
      return;
    }
    // If they typed trip directly e.g. Hillside to CBD
    if (lower.includes(' to ')) {
      const [pickup, dropoff] = text.split(/ to /i);
      sessions[phone] = { step: 'ask_name', pickup: pickup.trim(), dropoff: dropoff.trim() };
      await msg.reply(`Got it! ${pickup.trim()} → ${dropoff.trim()}\n\nWhat is your name?`);
      return;
    }
    sessions[phone] = { step: 'ask_trip' };
    await msg.reply(`Welcome to My Chauffeur Zim 🇿🇼\n\nWhere do you want to go? Type like this:\nHillside to CBD`);
    return;
  }

  // Step 1: Ask trip
  if (s.step === 'ask_trip' && lower.includes(' to ')) {
    const [pickup, dropoff] = text.split(/ to /i);
    s.pickup = pickup.trim(); s.dropoff = dropoff.trim(); s.step = 'ask_name';
    await msg.reply(`Got it! ${s.pickup} → ${s.dropoff}\n\nWhat is your name?`);
    return;
  }

  // Step 2: Ask name
  if (s.step === 'ask_name') {
    s.name = text; s.step = 'ask_time';
    await msg.reply(`Thanks ${s.name}. When? Reply:\n1 - Now\n2 - Later Today\n3 - Tomorrow`);
    return;
  }

  // Step 3: Ask time -> Create ride + Post to Website + Notify drivers
  if (s.step === 'ask_time') {
    s.time = text === '1' ? 'Now' : text === '2' ? 'Later Today' : text === '3' ? 'Tomorrow' : text;
    // Save ride to WEBSITE database
    const { data: ride } = await supabase.from('rides').insert([{
      customer_phone: phone, customer_name: s.name,
      pickup: s.pickup, dropoff: s.dropoff, when: s.time, status: 'waiting'
    }]).select().single();

    s.rideId = ride?.id; s.step = 'waiting_bids'; s.bids = [];
    await msg.reply(`✅ Posted! ${s.pickup} → ${s.dropoff} (${s.time})\n\nFinding drivers... You will get driver list + prices in 60 seconds.\nTown $8 | Airport $25`);
    // Notify ONLINE drivers
    await notifyDrivers(s);
    // After 30 sec, send what we have
    setTimeout(() => sendBidsToRider(s.rideId, phone), 30000);
    return;
  }

  // Step 4: Rider picks driver - replies 1 or 2
  if (s.step === 'waiting_bids' || s.step === 'picking') {
    const pick = parseInt(text);
    if (!isNaN(pick) && s.bids && s.bids[pick-1]) {
      const chosen = s.bids[pick-1];
      // Mark ride as booked + post rider info to driver
      await supabase.from('rides').update({ status: 'booked', chosen_driver: chosen.driver_phone }).eq('id', s.rideId);
      await supabase.from('bids').update({ status: 'accepted' }).eq('id', chosen.id);

      await msg.reply(`✅ You picked ${chosen.driver_name} - $${chosen.price}\n\nDriver will call you now on this number: ${phone}\nDriver number: ${chosen.driver_phone}\n\nPlease wait for call.`);
      // Message driver on WhatsApp with rider info
      const driverChatId = chosen.driver_phone + '@c.us';
      await client.sendMessage(driverChatId, `🎉 YOU WON THE RIDE!\n\nRider: ${s.name}\nPhone: ${phone}\nFrom: ${s.pickup} → ${s.dropoff}\nWhen: ${s.time}\nPrice: $${chosen.price}\n\nCALL RIDER NOW: ${phone}`);
      delete sessions[phone];
      return;
    } else {
      await msg.reply(`Reply with the number of the driver you want. E.g. Reply 1`);
      return;
    }
  }
});

async function notifyDrivers(s) {
  const { data: drivers } = await supabase.from('drivers').select('*').eq('status','online').limit(20);
  if (!drivers) return;
  for (const d of drivers) {
    try {
      driverSessions[d.phone] = { rideId: s.rideId };
      await client.sendMessage(d.phone + '@c.us',
        `🚖 NEW RIDE!\n${s.pickup} → ${s.dropoff} (${s.time})\nRider: ${s.name}\n\nTo BID, reply: BID 7  (your price)\nOr BID on driver page.`);
    } catch(e){}
  }
}

async function sendBidsToRider(rideId, riderPhone) {
  const { data: bids } = await supabase.from('bids').select('*').eq('ride_id', rideId).eq('status','pending').order('price');
  if (!bids || !bids.length) return;
  // Get driver names
  let list = '';
  let formatted = [];
  for (let i=0;i<bids.length;i++){
    const b = bids[i];
    const { data: d } = await supabase.from('drivers').select('*').eq('phone', b.driver_phone).single();
    const name = d?.name || 'Driver';
    const car = d?.car || '';
    formatted.push({ ...b, driver_name: name, driver_phone: b.driver_phone });
    list += `${i+1}. ${name} - ${car} - $${b.price}\n`;
  }
  // Find rider phone if not passed
  const { data: ride } = await supabase.from('rides').select('*').eq('id', rideId).single();
  const rPhone = riderPhone || ride?.customer_phone;
  if (!rPhone) return;
  sessions[rPhone] = { ...sessions[rPhone], step: 'picking', bids: formatted, rideId };
  await client.sendMessage(rPhone + '@c.us', `🚖 Drivers found for ${ride.pickup} → ${ride.dropoff}:\n\n${list}\nReply with number to pick. E.g. Reply 1`);
}

client.initialize();
