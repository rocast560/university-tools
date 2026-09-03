import path from 'node:path';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8140),
  tunnelPort: Number(env.TUNNEL_PORT ?? 8141),
  host: env.HOST ?? '127.0.0.1',
  dataDir: path.resolve(env.DATA_DIR ?? '.data'),
  staticDir: path.resolve(env.STATIC_DIR ?? 'dist'),
  pubchemLive: env.PUBCHEM_LIVE === '1',
};
