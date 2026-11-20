import { config } from './config.mjs';
import { RingLog } from './util.mjs';

export const logs = new RingLog(config.logRing);

export function record(entry) {
  logs.push(entry);
  const line = JSON.stringify(entry);
  if (process.env.LOG_STDOUT !== '0') console.log(line);
}
