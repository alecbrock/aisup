export interface RunnerConfig {
  command: string;
  args: string[];
  resume_flag: string;
  config_dir_env: string;
  remote_control_prefix: string | null;
}

export interface RunnerCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Full exec string for tmux send-keys: 'exec <token1> <token2> ...' */
  execString: string;
}
