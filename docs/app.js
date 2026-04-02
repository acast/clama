const button = document.getElementById("copy-command");

if (button) {
  button.addEventListener("click", async () => {
    const command = 'npm link && clama "hello"';
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = "Copy quick-start command";
      }, 1800);
    } catch {
      button.textContent = "Copy failed";
      window.setTimeout(() => {
        button.textContent = "Copy quick-start command";
      }, 1800);
    }
  });
}
