import { Command } from 'commander';
import { daemonStart, daemonStop } from './commands/daemon.js';
import { sessionStart } from './commands/start.js';
import { sessionStop } from './commands/stop.js';
import { sessionAttach } from './commands/attach.js';
import { showStatus } from './commands/status.js';
import { showLog } from './commands/log.js';
import { sessionCost } from './commands/cost.js';
import { showGates, runGateCommand } from './commands/gate.js';
import { showAccounts } from './commands/accounts.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { triggerFailover } from './commands/failover.js';

const program = new Command();

program
  .name('aisup')
  .description('AI supervisor daemon with multi-account failover')
  .version('0.1.0');

const daemon = program.command('daemon').description('Manage the aisup daemon process');

daemon
  .command('start')
  .description('Start the daemon in the background')
  .action(() => void daemonStart());

daemon
  .command('stop')
  .description('Stop the daemon')
  .action(() => void daemonStop());

program
  .command('start')
  .description('Start a supervised AI coding session')
  .option('--cwd <path>', 'Working directory for the session')
  .option('--plan <path>', 'Path to implementation plan file')
  .option('--dry-run', 'Validate and print selected account without starting')
  .action((opts: { cwd?: string; plan?: string; dryRun?: boolean }) =>
    void sessionStart(opts)
  );

program
  .command('stop')
  .description('Stop the current session gracefully')
  .option('--force', 'Force immediate termination')
  .action((opts: { force?: boolean }) => void sessionStop(opts));

program
  .command('attach')
  .description('Attach to the active session tmux window')
  .action(() => void sessionAttach());

program
  .command('status')
  .description('Show daemon and session status')
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { json?: boolean }) => void showStatus({ json: opts.json ?? false }));

program
  .command('log')
  .description('Show recent supervisor events')
  .option('--limit <n>', 'Number of events to show', '20')
  .option('--type <event_type>', 'Filter by event type (e.g. cost.snapshot)')
  .action((opts: { limit?: string; type?: string }) =>
    void showLog({ limit: opts.limit ? parseInt(opts.limit, 10) : 20, type: opts.type })
  );

program
  .command('cost')
  .description('Show cost/token usage (rolling today / 7d / 30d windows)')
  .option('--json', 'Print machine-readable JSON')
  .option('--since <date>', 'Aggregate cost since an ISO date/time')
  .option('--account <name>', 'Filter to a single account')
  .action((opts: { json?: boolean; since?: string; account?: string }) =>
    void sessionCost({ json: opts.json ?? false, since: opts.since, account: opts.account })
  );

const gate = program
  .command('gate')
  .description('Show the latest validation gate run')
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { json?: boolean }) => void showGates({ json: opts.json ?? false }));
gate
  .command('run')
  .description('Run the configured validation gates now')
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { json?: boolean }) => void runGateCommand({ json: opts.json ?? false }));

program
  .command('accounts')
  .description('Show account usage and health')
  .action(() => void showAccounts());

program
  .command('doctor')
  .description('Validate all prerequisites')
  .action(() => void runDoctor());

program
  .command('init')
  .description('Generate default config file')
  .option('--dry-run', 'Print what would be created without writing files')
  .option('--force', 'Overwrite existing config')
  .action((opts: { dryRun?: boolean; force?: boolean }) => void runInit(opts));

program
  .command('failover')
  .description('Trigger manual account failover')
  .requiredOption('--to <account>', 'Target account name')
  .action((opts: { to: string }) => void triggerFailover(opts.to));

program.parse(process.argv);
