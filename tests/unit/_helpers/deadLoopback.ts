/**
 * A loopback address:port with nothing listening — the hermetic way to say "this host is
 * unreachable" in a test.
 *
 * Tests used to point at a made-up public hostname (`p.example.com`, `bifrost.test.local`,
 * `192.0.2.1`) and rely on DNS failing or the packet being dropped. That is a real outbound
 * attempt: it depends on the machine's resolver, it is slow, and tests/_setup/blockNetwork.ts
 * (rightly) refuses it. A closed loopback port gives the same observable outcome —
 * ECONNREFUSED, immediately — without leaving the machine.
 */
import net from "node:net";

/** Binds an ephemeral loopback port, releases it, and returns it. */
export async function reserveDeadLoopbackPort(): Promise<number> {
  const server = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address !== null ? address.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** `127.0.0.1:<closed port>` as a host/port pair. */
export async function reserveDeadLoopbackTarget(): Promise<{ host: string; port: number }> {
  return { host: "127.0.0.1", port: await reserveDeadLoopbackPort() };
}
