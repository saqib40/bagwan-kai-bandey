export type Logger = {
  info: (message: string) => void;
  error: (message: string) => void;
};

export function makeLogger(): Logger {
  return {
    info: jest.fn(),
    error: jest.fn(),
  };
}

export function makeSequentialId(prefix: string): () => string {
  let counter = 0;
  const next = jest.fn(() => `${prefix}-${++counter}`);
  return next;
}
