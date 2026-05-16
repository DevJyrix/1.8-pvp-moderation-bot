const { spawn } = require('child_process');

// Jar lives in /app/lavalink (image layer, safe from volume mounts).
// CWD is /lavalink — that path can be a Railway Volume so OAuth tokens and
// plugin cache persist across redeploys. Copy config there before starting
// so Lavalink finds it in its CWD without any --spring.config.location flag.
const fs = require('fs');
fs.mkdirSync('/lavalink', { recursive: true });
fs.copyFileSync('/app/lavalink/application.yml', '/lavalink/application.yml');

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
