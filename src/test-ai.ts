import { runs, tasks } from "@trigger.dev/sdk"
import { Hono } from "hono"
import type { generateTextTest } from "./trigger/generate-text.js"

const testAi = new Hono()

testAi.get("/", async (c) => {
  const prompt = c.req.query("prompt") ?? "Say hello in one short sentence."

  const handle = await tasks.trigger<typeof generateTextTest>("generate-text-test", { prompt })

  const deadline = Date.now() + 30_000
  let run = await runs.retrieve(handle)

  while (!run.isCompleted && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000))
    run = await runs.retrieve(handle)
  }

  if (run.status !== "COMPLETED") {
    return c.json({ ok: false, runId: run.id, status: run.status }, 502)
  }

  return c.json({ ok: true, runId: run.id, text: run.output?.text })
})

export default testAi
