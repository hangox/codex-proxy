import { closeSync, constants, openSync } from "fs";

const RETRY_MS = 50;
// Darwin's O_EXLOCK is not exposed by Node's fs.constants. It requests an
// advisory exclusive lock during open(2); O_NONBLOCK turns contention into EAGAIN.
const DARWIN_O_EXLOCK = 0x20;

function requireDarwinExclusiveLock(): void {
  if (process.platform !== "darwin") {
    throw new Error("Electron test lock requires Darwin O_EXLOCK; this platform is intentionally unsupported");
  }
}

function isContended(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EAGAIN" || code === "EWOULDBLOCK";
}

export async function acquireElectronTestLock(lockFile: string): Promise<() => void> {
  requireDarwinExclusiveLock();

  for (;;) {
    try {
      // Never unlink this path while processes may contend: the persistent inode
      // is the lock identity, and the fd is the only ownership state.
      const descriptor = openSync(
        lockFile,
        constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | DARWIN_O_EXLOCK,
        0o600,
      );
      let released = false;
      return () => {
        // Mark released before close: a second invocation must not close a
        // descriptor number that the OS has already reused for a new holder.
        if (released) return;
        released = true;
        closeSync(descriptor);
      };
    } catch (error) {
      if (!isContended(error)) throw error;
      await new Promise((resolveRetry) => setTimeout(resolveRetry, RETRY_MS));
    }
  }
}
