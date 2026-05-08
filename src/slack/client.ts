import { App } from '@slack/bolt';

export interface SlackClientOpts {
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
}

export interface SlackClient {
  app: App;
  allowedUserIds: Set<string>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createSlackClient(opts: SlackClientOpts): SlackClient | null {
  if (!opts.botToken || !opts.appToken) {
    return null;
  }

  const app = new App({
    token: opts.botToken,
    appToken: opts.appToken,
    socketMode: true,
  });

  const allowedUserIds = new Set(opts.allowedUserIds);

  return {
    app,
    allowedUserIds,
    async start(): Promise<void> {
      await app.start();
    },
    async stop(): Promise<void> {
      await app.stop();
    },
  };
}
