import { Command } from 'commander';
import { daemonStart, daemonStop, daemonReload } from './commands/daemon.js';
import { sessionStart } from './commands/start.js';
import { sessionStop } from './commands/stop.js';
import { sessionAttach } from './commands/attach.js';
import { showStatus } from './commands/status.js';
import { showLog } from './commands/log.js';
import { runExplain } from './commands/explain.js';
import { sessionCost } from './commands/cost.js';
import { showGates, runGateCommand } from './commands/gate.js';
import {
  workerDispatch,
  workerList,
  workerStatus,
  workerProviders,
  workerReview,
  workerApprove,
  workerDeny,
  workerCancel,
  workerRetry,
  workerUndo,
  workerCleanup,
  workerLogs,
} from './commands/worker.js';
import { showAccounts, accountOverride } from './commands/accounts.js';
import { showHealth, runWatch } from './commands/watch.js';
import { runDoctor } from './commands/doctor.js';
import { runInit } from './commands/init.js';
import { triggerFailover } from './commands/failover.js';
import { sessionPause, sessionResume } from './commands/pause.js';
import { sessionTimeline, sessionRename } from './commands/session.js';

const program = new Command();

program
  .name('aisup')
  .description(
    'AI supervisor daemon with multi-account failover. ' +
    'Prerequisite: start the daemon first with `aisup daemon start` — session/query/worker commands ' +
    'talk to it over a localhost HTTP API and fail if it is not running.'
  )
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

daemon
  .command('reload')
  .description('Hot-reload config (SIGHUP): apply thresholds/verbosity live without dropping the session')
  .action(() => void daemonReload());

program
  .command('start')
  .description('Start a supervised AI coding session (requires the daemon: run `aisup daemon start` first)')
  .option('--cwd <path>', 'Working directory for the session')
  .option('--plan <path>', 'Path to implementation plan file')
  .option('--name <label>', 'Operator-facing label for the session')
  .option('--dry-run', 'Validate and print selected account without starting')
  .action((opts: { cwd?: string; plan?: string; name?: string; dryRun?: boolean }) =>
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
  .option('--account <name>', 'Filter by account')
  .option('--session <id>', 'Filter by aisup session id')
  .option('--since <iso>', 'Only events at or after this ISO timestamp')
  .option('--details', 'Show event details (e.g. failover rationale)')
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { limit?: string; type?: string; account?: string; session?: string; since?: string; details?: boolean; json?: boolean }) =>
    void showLog({
      limit: opts.limit ? parseInt(opts.limit, 10) : 20,
      type: opts.type, account: opts.account, session: opts.session, since: opts.since,
      details: opts.details, json: opts.json,
    })
  );

program
  .command('explain')
  .description('Explain what a journal event type means')
  .argument('<event_type>', 'Event type to explain (e.g. account.switch)')
  .action((eventType: string) => runExplain(eventType));

program
  .command('cost')
  .description('Show cost/token usage (rolling today / 7d / 30d windows)')
  .option('--json', 'Print machine-readable JSON')
  .option('--since <date>', 'Aggregate cost since an ISO date/time')
  .option('--account <name>', 'Filter to a single account')
  .option('--by <dimension>', 'Break down by: account | skill | provider | task')
  .action((opts: { json?: boolean; since?: string; account?: string; by?: string }) =>
    void sessionCost({ json: opts.json ?? false, since: opts.since, account: opts.account, by: opts.by })
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
  .description('Show account usage and health, or apply a runtime override')
  .option('--pin <name>', 'Force selection to this account while runnable')
  .option('--exclude <name>', 'Remove this account from selection')
  .option('--enable <name>', 'Runtime-enable this account')
  .option('--disable <name>', 'Runtime-disable this account')
  .option('--clear', 'Clear all runtime account overrides')
  .action((opts: { pin?: string; exclude?: string; enable?: string; disable?: string; clear?: boolean }) => {
    if (opts.pin || opts.exclude || opts.enable || opts.disable || opts.clear) return void accountOverride(opts);
    return void showAccounts();
  });

program
  .command('health')
  .description('Unified live snapshot: session, accounts, workers, cost-today, recent events')
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { json?: boolean }) => void showHealth({ json: opts.json ?? false }));

program
  .command('watch')
  .description('Auto-refreshing unified snapshot (Ctrl-C to exit)')
  .option('--interval <seconds>', 'Refresh interval in seconds (default 3)', (v) => parseInt(v, 10))
  .action((opts: { interval?: number }) => void runWatch({ interval: opts.interval }));

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

const session = program.command('session').description('Inspect and label supervised sessions');
session
  .command('timeline [id]')
  .description('Print the ordered lifecycle of a session (defaults to the current one)')
  .option('--json', 'Print machine-readable JSON')
  .action((id: string | undefined, opts: { json?: boolean }) => void sessionTimeline({ id, json: opts.json ?? false }));
session
  .command('rename <id> <name>')
  .description('Set a session\'s operator-facing label')
  .action((id: string, name: string) => void sessionRename(id, name));

program
  .command('pause')
  .description('Pause the active session (SIGSTOP its runner) to save headroom')
  .action(() => void sessionPause());

program
  .command('resume')
  .description('Resume a paused session (SIGCONT its runner)')
  .action(() => void sessionResume());

program
  .command('failover')
  .description('Trigger manual account failover')
  .requiredOption('--to <account>', 'Target account name')
  .action((opts: { to: string }) => void triggerFailover(opts.to));

const worker = program.command('worker').description('Manage multi-LLM workers');
worker
  .command('dispatch')
  .description('Dispatch a bounded task to an LLM worker')
  .option('--task-type <type>', 'Routing key (e.g. implement, bugfix)')
  .requiredOption('--prompt <text|@file>', 'Task prompt, or @path to load from a file')
  .option('--title <title>', 'Short title (defaults to the truncated prompt)')
  .option('--implementer <adapter>', 'Override the implementer adapter')
  .option('--reviewer <adapter>', 'Override the reviewer adapter')
  .option('--base <ref>', 'Base git ref to branch the worktree from')
  .option('--workspace <path>', 'Workspace root (main git repo)')
  .action((opts: { taskType?: string; prompt?: string; title?: string; implementer?: string; reviewer?: string; base?: string; workspace?: string }) =>
    void workerDispatch(opts)
  );
worker
  .command('list')
  .description('List workers')
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { json?: boolean }) => void workerList({ json: opts.json ?? false }));
worker
  .command('providers')
  .description('Show per-provider availability for each worker role (claude headroom, codex budget)')
  .option('--json', 'Print machine-readable JSON')
  .action((opts: { json?: boolean }) => void workerProviders({ json: opts.json ?? false }));
worker
  .command('status <id>')
  .description('Show a worker\'s status')
  .option('--json', 'Print machine-readable JSON')
  .action((id: string, opts: { json?: boolean }) => void workerStatus(id, { json: opts.json ?? false }));
worker
  .command('review <id>')
  .description('Show the cross-model review verdict')
  .action((id: string) => void workerReview(id));
worker
  .command('logs <id>')
  .description('Show the worker\'s sanitized stdout/stderr tails and artifact paths')
  .option('--follow', 'Stream live output until the worker reaches a terminal state')
  .action((id: string, opts: { follow?: boolean }) => void workerLogs(id, { follow: opts.follow ?? false }));
worker
  .command('approve <id>')
  .description('Approve and merge a worker patch')
  .action((id: string) => void workerApprove(id));
worker
  .command('deny <id>')
  .description('Deny a worker patch')
  .action((id: string) => void workerDeny(id));
worker
  .command('cancel <id>')
  .description('Cancel a worker')
  .action((id: string) => void workerCancel(id));
worker
  .command('retry <id>')
  .description('Re-dispatch a failed/denied/cancelled worker from its original task')
  .action((id: string) => void workerRetry(id));
worker
  .command('undo <id>')
  .description('Revert a merged worker patch from the working tree (refuses on divergence)')
  .action((id: string) => void workerUndo(id));
worker
  .command('cleanup')
  .description('List orphaned aisup worktrees; --force removes them')
  .option('--force', 'Remove the orphaned worktrees (not just list)')
  .action((opts: { force?: boolean }) => void workerCleanup({ force: opts.force ?? false }));

program.parse(process.argv);
