const bcrypt = require("bcryptjs");
const { stdin, stdout } = require("node:process");

function readPassword() {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Run this command in an interactive terminal so the password is not echoed.");
  }
  return new Promise((resolve, reject) => {
    let password = "";
    const finish = (error) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
      if (error) reject(error);
      else resolve(password);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") return finish(new Error("Password generation cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          password = password.slice(0, -1);
          continue;
        }
        password += character;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function main() {
  stdout.write("New administrator password (minimum 12 characters): ");
  const password = await readPassword();
  if (password.length < 12) throw new Error("Administrator password must contain at least 12 characters.");
  console.log(await bcrypt.hash(password, 12));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
