global.WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    executablePath: '/usr/bin/chromium',
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--disable-accelerated-2d-canvas','--no-first-run','--no-zygote','--single-process']
  }
});

client.on('qr', (qr) => { console.log('QR received, but using pairing code instead...'); });
client.on('code', (code) => {
  console.log('====================================');
  console.log('YOUR PAIRING CODE IS: ' + code);
  console.log('Go to WhatsApp > Linked devices > Link with phone number');
  console.log('Enter this code: ' + code);
  console.log('====================================');
});
client.on('ready', () => { console.log('My Chauffeur Zim Bot is ready!'); });
client.on('auth_failure', (msg) => { console.log('Auth failed:', msg); });

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
// Simple km estimate: you will replace with real Maps later.
// For now: ask customer for km OR use 5km default if they don't know.
function estimateKm(pickup, dropoff){
  // TODO: plug in Google Maps Distance Matrix here
  // For now return null so we ask user
  return null;
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
    const raw = msg.body.trim();

    if (text === 'hi' || text === 'hello' || text === 'menu') {
      userState[from] = { step: 'menu' };
      return msg.reply(MAIN_MENU);
    }
    if (!userState[from]) {
      userState[from] = { step: 'menu' };
      return msg.reply(MAIN_MENU);
    }

    // === CUSTOMER PICKS DRIVER FROM TOP 5 ===
    if (userState[from].step === 'pick_driver') {
      let choice = parseInt(raw);
      let drivers = userState[from].topDrivers || [];
      if(!choice || choice < 1 || choice > drivers.length){
        return msg.reply(`Please type a number 1 to ${drivers.length} to pick your driver.`);
      }
      let chosen = drivers[choice-1];
      // Mark ride as assigned
      await supabase.from('rides').update({ status: 'assigned', chosen_driver: chosen.driver_phone }).eq('id', userState[from].rideId);
      // Send customer number ONLY to chosen driver via WhatsApp DM (private)
      // We send via bot to driver number - driver number is in Zim format, convert to WhatsApp ID
      try {
        let driverWa = chosen.driver_phone.replace(/[^0-9]/g,'');
        if(driverWa.startsWith('0')) driverWa = '263' + driverWa.slice(1);
        await client.sendMessage(driverWa + '@c.us', `🎉 *YOU WERE CHOSEN!*\n\nRide: ${userState[from].booking.pickup} → ${userState[from].booking.dropoff}\nTotal: $${userState[from].total.toFixed(2)} - YOU KEEP ALL\n\nCustomer Name: ${userState[from].booking.name}\nCustomer Number: ${from.replace('@c.us','')}\nCall them now to confirm pickup.`);
      } catch(e){ console.log('Could not DM driver', e.message); }

      userState[from].step = 'done';
      return msg.reply(`✅ *Driver Chosen!*\n\nDriver: ${chosen.driver_name || chosen.driver_phone}\nCar: ${chosen.car || 'Verified Car'}\nPlate: ${chosen.plate || ''}\n\nTotal to pay driver: $${userState[from].total.toFixed(2)}\n(Fare $${userState[from].fare.toFixed(2)} + Fee $${userState[from].fee.toFixed(2)})\n\nDriver will call you now. Type *hi* for menu.`);
    }

    if (text === '1' && userState[from].step === 'menu') {
      userState[from] = { step: 'pickup', booking: {} };
      return msg.reply(`🚖 *Book a Ride*\n\nWhere should we pick you up from?`);
    }
    if (userState[from].step === 'pickup') {
      userState[from].booking.pickup = raw;
      userState[from].step = 'dropoff';
      return msg.reply(`Great. Where are you going to?`);
    }
    if (userState[from].step === 'dropoff') {
      userState[from].booking.dropoff = raw;
      userState[from].step = 'ride_type';
      return msg.reply(`Is this ride *In-City* or *Outside City*?\n\nType *1* for In-City (under 15km)\nType *2* for Outside City (15km+)`);
    }
    if (userState[from].step === 'ride_type') {
      if(raw === '1') userState[from].booking.ride_type = 'In-City';
      else if(raw === '2') userState[from].booking.ride_type = 'Outside City';
      else return msg.reply(`Type *1* for In-City or *2* for Outside City`);
      userState[from].step = 'km';
      return msg.reply(`How many km is it? (If you don't know, type *don't know* and we will estimate 5km)\n\nExample: 7`);
    }
    if (userState[from].step === 'km') {
      let km = parseFloat(raw);
      if(isNaN(km)) km = 5; // default estimate
      userState[from].booking.km = km;
      let fare = calcFare(km);
      let fee = calcFee(km, userState[from].booking.ride_type);
      let total = fare + fee;
      userState[from].fare = fare; userState[from].fee = fee; userState[from].total = total;
      userState[from].step = 'datetime';
      return msg.reply(`💰 *Price Estimate*\n\nDistance: ${km}km • ${userState[from].booking.ride_type}\nFare: $${fare.toFixed(2)} ( $1.50 per km )\nDriver Fee: $${fee.toFixed(2)}\n*Total to pay driver: $${total.toFixed(2)}*\nDriver keeps ALL of it.\n\nWhen do you need the ride? (e.g. Today 2pm / Tomorrow 9am)`);
    }
    if (userState[from].step === 'datetime') {
      userState[from].booking.datetime = raw;
      userState[from].step = 'name';
      return msg.reply(`What is your name?`);
    }
    if (userState[from].step === 'name') {
      userState[from].booking.name = raw;
      // Save to RIDES table (same table driver page uses) - NOT bookings
      const rideData = {
        pickup: userState[from].booking.pickup,
        dropoff: userState[from].booking.dropoff,
        km: userState[from].booking.km,
        ride_type: userState[from].booking.ride_type,
        price: userState[from].fare, // fare only
        driver_fee: userState[from].fee,
        total_price: userState[from].total,
        customer_phone: from.replace('@c.us',''),
        customer_name: userState[from].booking.name,
        datetime: userState[from].booking.datetime,
        city: 'Bulawayo',
        status: 'waiting'
      };
      const { data, error } = await supabase.from('rides').insert([rideData]).select().single();
      if (error) {
        console.log('Supabase error:', error.message);
        userState[from].step = 'done';
        return msg.reply(`Thanks ${userState[from].booking.name}! We got your request. We will confirm shortly.\n\nType *hi* to go back to menu`);
      }
      userState[from].rideId = data.id;
      userState[from].step = 'waiting_drivers';
      await msg.reply(`✅ *Booking Received!*\n\nName: ${userState[from].booking.name}\nFrom: ${userState[from].booking.pickup}\nTo: ${userState[from].booking.dropoff}\nWhen: ${userState[from].booking.datetime}\nTotal: $${userState[from].total.toFixed(2)}\n\n⏱️ Finding drivers... waiting 60 seconds for first 5 bids...`);

      // Wait 60 seconds, then fetch first 5 bids
      setTimeout(async () => {
        try {
          const { data: bids } = await supabase.from('bids').select('*').eq('ride_id', data.id).order('created_at', {ascending:true}).limit(5);
          if(!bids || bids.length === 0){
            await client.sendMessage(from, `😔 No drivers bid in 60 seconds. Trying again... Type *1* to rebook.`);
            userState[from].step = 'done';
            return;
          }
          // Enrich with driver details (name, car, plate) - but NEVER send customer phone to drivers
          let enriched = [];
          for(let b of bids){
            const { data: drv } = await supabase.from('drivers').select('name,car,car_detail,plate,phone').eq('phone', b.driver_phone).single();
            enriched.push({ driver_phone: b.driver_phone, driver_name: drv?.name || 'Driver', car: drv?.car || '', plate: drv?.plate || '', total: userState[from].total });
          }
          userState[from].topDrivers = enriched;
          userState[from].step = 'pick_driver';
          let list = enriched.map((d,i) => `*${i+1}.* ${d.driver_name} - ${d.car} ${d.plate}`).join('\n');
          await client.sendMessage(from, `🚖 *Top ${enriched.length} Drivers Found (60 sec)*\n\n${list}\n\nTotal: $${userState[from].total.toFixed(2)}\n\nType the NUMBER (1-${enriched.length}) to pick your driver.`);
        } catch(e){ console.log('Bids fetch error', e.message); }
      }, 60000);
      return;
    }
    if (text === '2') {
      return msg.reply(`💰 *My Chauffeur Zim Prices - Bulawayo*\n\n• $1.50 per km\n• + $0.50 fee if under 15km / In-City\n• + $1.00 fee if 15km+ / Outside City\n• Driver keeps ALL of total\n\nExample:\n5km In-City: $7.50 + $0.50 = $8.00\n20km Outside: $30.00 + $1.00 = $31.00\n\nType *1* to Book a Ride`);
    }
    if (text === '3') {
      return msg.reply(`📞 *Support*\n\nCall / WhatsApp us on: 0783264675\nWe reply within 3 minutes.\n\nType *hi* to go back to menu`);
    }
    if (!userState[from] || userState[from].step === 'done') {
      return msg.reply(`Hi! 👋 Type *hi* to see the menu.`);
    }
  } catch (err) {
    console.log('Message error:', err.message);
  }
});

// Start with Pairing Code
client.initialize().then(async () => {
  const phone = process.env.PHONE_NUMBER;
  if (phone && !client.info) {
    try {
      const code = await client.requestPairingCode(phone);
      console.log('====================================');
      console.log('YOUR PAIRING CODE IS: ' + code);
      console.log('====================================');
    } catch (e) {
      console.log('Pairing code error:', e.message);
    }
  }
});
