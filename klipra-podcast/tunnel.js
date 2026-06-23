const localtunnel = require('localtunnel');

const PORT = 3000;
const BASE_SUBDOMAIN = 'klipra-podcast-v24i';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function startTunnel() {
  console.log(`Starting tunnel pointing to local port ${PORT}...`);
  let consecutiveFailures = 0;
  
  while (true) {
    try {
      // Use the stable subdomain first; append a random string only if we fail repeatedly to clear port hangs.
      const sub = consecutiveFailures > 2 
        ? `${BASE_SUBDOMAIN}-${Math.random().toString(36).substring(2, 6)}`
        : BASE_SUBDOMAIN;

      console.log(`[Tunnel] Requesting subdomain: ${sub}`);
      const tunnel = await localtunnel({ 
        port: PORT,
        subdomain: sub
      });

      console.log('\n======================================================');
      console.log(`🚀 Klipra Podcast Studio is live on the internet!`);
      console.log(`👉 Guest invite URL: ${tunnel.url}`);
      console.log('======================================================\n');
      
      consecutiveFailures = 0; // Reset failures on success

      tunnel.on('error', (err) => {
        console.error(`[Tunnel Error] ${new Date().toISOString()}:`, err.message || err);
        try { tunnel.close(); } catch (_) {}
      });

      await new Promise((resolve) => {
        tunnel.on('close', () => {
          console.log(`[Tunnel Closed] ${new Date().toISOString()}. Reconnecting in 5s...`);
          resolve();
        });
      });

    } catch (err) {
      consecutiveFailures++;
      console.error(`[Tunnel Connection Failed] Failures: ${consecutiveFailures}:`, err.message || err);
    }
    
    // Wait 5 seconds before retrying
    await sleep(5000);
  }
}

startTunnel();

