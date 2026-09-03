import path from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  workspacesDir: string;
  staticDir: string | null;
  typstCli: string | null;
  token: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  return {
    port: Number(env.PORT ?? 8090),
    host: env.HOST ?? '127.0.0.1',
    dataDir,
    workspacesDir: path.join(dataDir, 'workspaces'),
    staticDir: env.STATIC_DIR ? path.resolve(env.STATIC_DIR) : null,
    typstCli: env.TYPST_CLI ? path.resolve(env.TYPST_CLI) : null,
    token: env.APP_TOKEN || null,
  };
}
