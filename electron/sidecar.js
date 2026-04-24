const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const http = require('http');

let proc = null;
let chosenPort = null;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 15000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 500 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on('error', retry);
    };
    const retry = () => {
      if (Date.now() - start > timeoutMs) return reject(new Error('backend did not become healthy'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

function resolveBackendCommand(isDev) {
  if (isDev) {
    const repo = path.resolve(__dirname, '..');
    const py = process.env.CALIB_PYTHON || 'python3';
    return { cmd: py, args: ['-m', 'app.main'], cwd: path.join(repo, 'backend') };
  }
  // Packaged: electron-builder extraResources places the binary under resources/backend/
  const binName = process.platform === 'win32' ? 'calib-backend.exe' : 'calib-backend';
  const bin = path.join(process.resourcesPath, 'backend', binName);
  if (!fs.existsSync(bin)) throw new Error(`packaged backend not found at ${bin}`);
  return { cmd: bin, args: [], cwd: path.dirname(bin) };
}

async function startSidecar({ isDev }) {
  chosenPort = await getFreePort();
  const { cmd, args, cwd } = resolveBackendCommand(isDev);
  const env = { ...process.env, CALIB_PORT: String(chosenPort), CALIB_HOST: '127.0.0.1' };

  proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (b) => process.stdout.write(`[backend] ${b}`));
  proc.stderr.on('data', (b) => process.stderr.write(`[backend] ${b}`));
  proc.on('exit', (code, sig) => {
    console.log(`[backend] exited code=${code} sig=${sig}`);
    proc = null;
  });

  try {
    await waitForHealth(chosenPort);
  } catch (err) {
    stopSidecar();
    throw err;
  }
  return { port: chosenPort };
}

function stopSidecar() {
  if (!proc) return;
  try { proc.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => { if (proc) try { proc.kill('SIGKILL'); } catch (_) {} }, 2000);
}

module.exports = { startSidecar, stopSidecar };
