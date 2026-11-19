// main.ts — the trial lifecycle for the Anvil forge.
//
// The harness runs this file as `node /bot/main.ts`. The env process owns a
// fixed port; this entry binds an ephemeral one, tells the env where it
// lives, then waits until the env says the trial is over:
//
//   1. Without MAKEFUN_ENV_URL there is nothing to register with: exit 1.
//   2. createApp() listens on port 0 (never a fixed port — the env owns its).
//   3. POST $MAKEFUN_ENV_URL/register with {"port": N}. The env derives the
//      entry's base URL from the request's origin plus N and dials it from
//      then on. 200 and 409 both mean "registered" (the first register
//      wins); 400/405 are contract errors and fatal; anything else is
//      retried with a short exponential backoff while the env starts.
//   4. GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//   5. Close the server and exit 0.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('MAKEFUN_ENV_URL is not set; nowhere to register\n');
  process.exit(1);
}

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2_000;

function backoff(attempt: number): number {
  return Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * 2 ** Math.min(attempt, 8));
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Register the bound port, retrying transient failures until accepted. */
async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    let status: number | null = null;
    try {
      const response = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = response.status;
      if (status === 400 || status === 405) {
        throw new Error(`register refused with HTTP ${status}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('register refused')) throw error;
      status = null; // a network failure: the env may still be starting
    }
    if (status === 200 || status === 409) return;
    await pause(backoff(attempt));
  }
}

/** Poll /done; only returns once the env reports the trial is finished. */
async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(`${envUrl}/done`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Not reachable yet is just another "not done".
    }
    await pause(backoff(attempt));
  }
}

const server = createApp();
await new Promise<void>((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') {
  process.stderr.write('the server did not bind an ephemeral TCP port\n');
  process.exit(1);
}
await announce(address.port);
await untilDone();
server.close();
process.exit(0);
