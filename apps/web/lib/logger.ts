import pino from 'pino';
import { webEnv } from '@/lib/config';

export const logger = pino({
  level: webEnv.NODE_ENV === 'production' ? 'info' : 'debug',
  ...(webEnv.NODE_ENV !== 'production' && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    },
  }),
});

export function createChildLogger(bindings: Record<string, unknown>) {
  return logger.child(bindings);
}
