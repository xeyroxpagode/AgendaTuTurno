import { database } from "../../../apps/api/src/lib/runtime.js";
import { confirmSession } from "../../../apps/api/src/modules/courses/session-commands.js";
import { durableAttemptState } from "../../../apps/api/src/modules/system/operations.js";
import { authenticateQaActor, QA_EMAILS } from "../../support/h07-h08-auth.js";
import { assertQaDatabase } from "../../support/h07-h08-seed.js";

const report = (message: object) => new Promise<void>((resolve, reject) => {
  if (!process.send) return reject(new Error("QA worker requires an IPC channel"));
  process.send(message, (error) => error ? reject(error) : resolve());
});
const [mode, operationId, sessionId] = process.argv.slice(2);
await assertQaDatabase(database.client);
const actor = await authenticateQaActor(QA_EMAILS.owner);
try {
  if (mode === "query") {
    await report({ outcome: "read", pid: process.pid, ...(await durableAttemptState(operationId!, actor)) });
  } else {
    await report({ outcome: "entered", pid: process.pid });
    const result = await confirmSession(actor, { sessionId: sessionId! }, operationId!);
    if (mode === "pause-after-commit") {
      await report({ outcome: "committed", pid: process.pid });
      await new Promise((resolve) => process.once("disconnect", resolve));
    } else {
      await report({ outcome: "result", pid: process.pid, ...result });
    }
  }
} catch (error) {
  await report({ outcome: "error", pid: process.pid, code: (error as { code?: string }).code });
} finally {
  await database.client.end({ timeout: 3 });
  if (process.connected) process.disconnect();
  process.exit(0);
}
