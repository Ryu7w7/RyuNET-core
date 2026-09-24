export type AogHandler = (req: any, res: any) => Promise<void>;

const handlers = new Map<string, AogHandler>();
let fallback: AogHandler | null = null;

export function registerAogRoute(name: string, handler: AogHandler) {
  handlers.set(name, handler);
}

export function registerAogFallback(handler: AogHandler) {
  fallback = handler;
}

export function getAogHandler(name: string): AogHandler | undefined {
  return handlers.get(name);
}

export function getAogFallback(): AogHandler | null {
  return fallback;
}

export function listAogHandlers(): string[] {
  return Array.from(handlers.keys());
}
