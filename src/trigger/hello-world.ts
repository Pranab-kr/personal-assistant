import { task } from "@trigger.dev/sdk"

export const helloWorld = task({
  id: "hello-world",
  run: async (payload: { name?: string }) => {
    const name = payload.name?.trim() || "world"
    const message = `Hello, ${name}!`

    console.log(message)

    return { message }
  }
})
