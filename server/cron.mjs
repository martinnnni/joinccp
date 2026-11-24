import worker from "../worker.js";
import { createRuntime } from "./runtime.mjs";

const { env, db } = createRuntime();
try {
  await worker.scheduled({ scheduledTime: Date.now(), cron: "0 1 * * *" }, env);
} finally {
  db.close();
}
