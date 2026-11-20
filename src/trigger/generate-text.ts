import { task } from "@trigger.dev/sdk"
import { generateText } from "ai"
import { model } from "../ai.js"

export const generateTextTest = task({
  id: "generate-text-test",
  run: async (payload: { prompt: string }) => {
    const { text } = await generateText({
      model,
      prompt: payload.prompt
    })

    return { text }
  }
})
