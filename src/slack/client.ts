// Slack bolt app initialization — wired when slack.enabled is true
// Full Socket Mode initialization requires real tokens; stub here for type safety.
export interface SlackClientOpts {
  botToken: string;
  appToken: string;
  allowedUserIds: string[];
}

export function createSlackClient(_opts: SlackClientOpts): null {
  // Real bolt App initialization wired in Task 12 daemon startup
  return null;
}
