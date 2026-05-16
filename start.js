const { spawn } = require('child_process');
const fs = require('fs');

fs.mkdirSync('/lavalink', { recursive: true });
fs.copyFileSync('/app/lavalink/application.yml', '/lavalink/application.yml');

// Start the Node.js cipher resolver so Lavalink can offload
// YouTube player script decryption to us instead of using its Java regex.
require('./cipher-server')();

if (process.env.YOUTUBE_REFRESH_TOKEN) {
  console.log('[OAuth] YOUTUBE_REFRESH_TOKEN is set — OAuth pre-configured, no device code needed.');
} else {
  console.log('[OAuth] YOUTUBE_REFRESH_TOKEN not set. A device code will appear below.');
  console.log('[OAuth] Go to https://www.google.com/device and enter it (use a burner Google account).');
  console.log('[OAuth] After you authorize, this script will print the token — copy it to Railway Variables as YOUTUBE_REFRESH_TOKEN.');
  watchForToken();
}

function watchForToken() {
  const tokenPath = '/lavalink/oauth_tokens.json';
  let printed = null;
  setInterval(() => {
    try {
      const raw = fs.readFileSync(tokenPath, 'utf8');
      const data = JSON.parse(raw);
      // find a value that looks like a Google refresh token
      const token = Object.values(data).find(v => typeof v === 'string' && v.startsWith('1//'));
      if (token && token !== printed) {
        printed = token;
        const line = '='.repeat(72);
        console.log('\n' + line);
        console.log('[OAuth] TOKEN SAVED — do this ONE TIME in Railway → Variables:');
        console.log(`  Name:  YOUTUBE_REFRESH_TOKEN`);
        console.log(`  Value: ${token}`);
        console.log('[OAuth] Railway will redeploy automatically. Music will work forever after.');
        console.log(line + '\n');
      }
    } catch {
      // file not written yet — keep polling
    }
  }, 3000);
}

const lavalink = spawn(
  'java',
  ['-Xmx256m', '-jar', '/app/lavalink/Lavalink.jar'],
  {
    cwd: '/lavalink',
    stdio: ['ignore', 'pipe', 'pipe'],
  }
);

let botStarted = false;

lavalink.stdout.on('data', chunk => {
  const text = chunk.toString();
  process.stdout.write(text);
  if (!botStarted && text.includes('Lavalink is ready to accept connections')) {
    botStarted = true;
    launchBot();
  }
});

lavalink.stderr.on('data', chunk => process.stderr.write(chunk.toString()));

lavalink.on('exit', code => {
  console.error(`[Lavalink] process exited with code ${code}`);
  process.exit(1);
});

function launchBot() {
  console.log('[start] Lavalink ready — starting bot');
  const bot = spawn('node', ['index.js'], {
    cwd: '/app',
    stdio: 'inherit',
    env: {
      ...process.env,
      LAVALINK_HOST: 'localhost',
      LAVALINK_PORT: '2333',
      LAVALINK_AUTH: 'youshallnotpass',
    },
  });
  bot.on('exit', code => process.exit(code ?? 0));
}

// Start bot after 90s even if Lavalink didn't signal ready
setTimeout(() => {
  if (!botStarted) {
    console.warn('[start] Lavalink did not signal ready within 90s — starting bot anyway');
    botStarted = true;
    launchBot();
  }
}, 90_000);
