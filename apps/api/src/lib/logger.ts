import pino from 'pino';
import { env } from '../config.js';

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type LogLevel = (typeof LEVELS)[number];

const defaultLevel: LogLevel = env.NODE_ENV === 'production' ? 'info' : 'debug';

export const logger = pino({
  level: env.LOG_LEVEL ?? defaultLevel,
  ...(env.NODE_ENV !== 'production' && {
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

export function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LEVELS as readonly string[]).includes(value);
}

// Children follow the root unless they were given a level of their own.
// createChildLogger never passes one, so raising verbosity here reaches the
// queue workers too, including children built long before the change.
//
// Single instance, so this changes everything. Behind a load balancer it would
// only reach whichever process served the request.
export function setLogLevel(level: LogLevel): LogLevel {
  const previous = logger.level as LogLevel;
  logger.level = level;
  return previous;
}
