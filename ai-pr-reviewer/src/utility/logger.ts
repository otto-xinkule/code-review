import pino from 'pino';

/**
 * Structured logger using pino.
 * Log level is controlled via LOG_LEVEL environment variable.
 */

const level = process.env.LOG_LEVEL || 'info';

export const logger = pino({
  level,
  transport: process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
        },
      }
    : undefined,
  formatters: {
    level(label) {
      return { level: label };
    },
  },
});

export function createChildLogger(name: string) {
  return logger.child({ module: name });
}

export default logger;
