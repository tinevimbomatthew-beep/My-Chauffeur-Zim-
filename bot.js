const fs = require('fs');
global.WebSocket = require('ws');
const { default: makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');

const PHONE = '263783264675';
let asked = false;

async function start() {
  const { version } = await fetchLatestBaileysVersion();
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/auth');
  const sock = makeWASocket({ version, auth: state, logger: pino({ level: 'silent' }), browser: ['Chauffeur', 'Chrome', '1.0'] });
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    console.log('STATUS:' + u.connection);

    if (u.connection === 'connecting' && !sock.authState.creds.registered && !asked) {
      asked = true;
      // Wait 3 sec for socket to be ready, then ask ONCE
      setTimeout(async () => {
        try {
          const code = await sock.requestPairingCode(PHONE);
          console.log('========================');
          console.log('YOUR_CODE_IS:' + code);
          console.log('USE THIS ONE ONLY - NO NEW CODE COMING');
          console.log('========================');
        } catch (e) { console.log('FAIL:' + e.message); asked = false; }
      }, 3000);
    }

    if (u.connection === 'open') {
      console.log('BOT IS READY');
    }

    if (u.connection === 'close') {
      console.log('CLOSED:' + u.lastDisconnect?.error?.output?.statusCode);
      asked = false;
      try { fs.rmSync('/tmp/auth', { recursive: true, force: true }); } catch {}
      setTimeout(start, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    const m = messages[0];
    if (!m.message || m.key.fromMe) return;
    const text = (m.message.conversation || '').trim().toLowerCase();
    if (text === 'hi' || text === 'hello') {
      await sock.sendMessage(m.key.remoteJid, { text: 'Hi! My Chauffeur Zim is working 🚕' });
    }
  });
}
start();
