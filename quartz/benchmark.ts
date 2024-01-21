import fs from "fs"
import subProcess from "child_process"

// Set up test.md file
const filename = "C:\\Users\\Kabir\\Documents\\Projects\\quartz\\content\\test.md"
let lastline = generateRandomAsciiString(10)

fs.readFile(filename, "utf8", function (_err, data) {
  let newdata = data + `\n${lastline}`
  fs.writeFileSync(filename, newdata)
})

// setup quartz in serve mode
// const child = subProcess.spawn("npx", "quartz build --serve --output benchmark".split(" "), {
const child = subProcess.spawn(
  "npx",
  "quartz build --serve --fastRebuild --output benchmark".split(" "),
  {
    cwd: "C:\\Users\\Kabir\\Documents\\Projects\\quartz",
    shell: true,
  },
)

// Listen for standard output data
child.stdout.on("data", (data) => {
  console.log(`stdout: ${data}`)
})

// Listen for standard error data
child.stderr.on("data", (data) => {
  console.error(`stderr: ${data}`)
})

// Handle the close event of the child process
child.on("close", (code) => {
  console.log(`child process exited with code ${code}`)
})

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
// wait for build to finish
await delay(7000)

function generateRandomAsciiString(length: number) {
  let result = ""
  const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const charactersLength = characters.length

  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.floor(Math.random() * charactersLength))
  }

  return result
}

// edit test.md (change last line to random text) and save
for (let i = 0; i < 20; i++) {
  fs.readFile(filename, "utf8", function (_err, data) {
    let nextline = generateRandomAsciiString(10)
    let newdata = data.replace(lastline, nextline)
    lastline = nextline
    fs.writeFileSync(filename, newdata)
  })

  await delay(6000)
}

child.kill()
console.log("---------- DONE ----------")
