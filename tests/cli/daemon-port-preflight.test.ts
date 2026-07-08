import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:net';
import { writeFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const home = vi.hoisted(() => {
  const os = require('node:os') as typeof import('node:os');
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aisup-port-'));
  process.env.AISUP_HOME = dir;
  return dir;
});

import { daemonStart, checkPortFree } from '../../src/cli/commands/daemon.js';
import { generateInitConfig } from '../../src/cli/commands/init.js';

function listenOn(port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}
function assignedPort(srv: Server): number {
  const a = srv.address();
  return typeof a === 'object' && a ? a.port : 0;
}

describe('C5: daemon port preflight', () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers) s.close();
    servers.length = 0;
    vi.restoreAllMocks();
    rmSync(join(home, 'daemon.pid'), { force: true });
  });
  beforeEach(() => { if (!existsSync(home)) mkdirSync(home, { recursive: true }); });

  it('checkPortFree reports an occupied port as not free and a free port as free', async () => {
    const busy = await listenOn(0);
    servers.push(busy);
    const busyPort = assignedPort(busy);
    expect(await checkPortFree(busyPort)).toBe(false);

    const probe = await listenOn(0);
    const freePort = assignedPort(probe);
    await new Promise<void>((r) => probe.close(() => r()));
    expect(await checkPortFree(freePort)).toBe(true);
  });

  it('daemon start prints a clear error (not a silent detached exit) when the port is occupied', async () => {
    // Occupy an ephemeral port and point the daemon config at it.
    const busy = await listenOn(0);
    servers.push(busy);
    const port = assignedPort(busy);
    const yaml = generateInitConfig().yaml.replace(/port:\s*\d+/, `port: ${port}`);
    writeFileSync(join(home, 'config.yaml'), yaml, { mode: 0o600 });

    let stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { stderr += String(chunk); return true; });
    const exit = vi.spyOn(process, 'exit').mockImplementation(((): never => { throw new Error('EXIT'); }) as never);

    await expect(daemonStart()).rejects.toThrow('EXIT');
    expect(exit).toHaveBeenCalledWith(1);
    expect(stderr).toMatch(new RegExp(`port ${port}`));
    expect(stderr).toMatch(/in use|already/i);
  });
});
