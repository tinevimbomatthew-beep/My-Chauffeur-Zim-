const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const client = new Client({ authStrategy: new LocalAuth(), puppeteer: { args: ['--no-sandbox'] } });

client.on('qr', qr => { qrcode.generate(qr, { small: true }); console.log('SCAN THIS QR WITH 0783264675'); });
client.on('ready', () => console.log('✅ BOT ONLINE - 0783264675'));

client.on('message', async msg => {
  const text = msg.body.toLowerCase();
  if (text.includes('hi') || text.includes('ride')) {
    await msg.reply(`Welcome to My Chauffeur Zim 🇿🇼\n\nWhere do you want to go? Type like this:\nHillside to CBD`);
  } else if (text.includes(' to ')) {
    await msg.reply(`Got it! ${msg.body}\n\nPosting to drivers now... You will get driver bids in 60 seconds.\nTown $8 | Airport $25`);
  }
});

client.initialize();
