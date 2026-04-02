const button = document.getElementById("copy-command");

if (button) {
  button.addEventListener("click", async () => {
    const command = 'npm link && clama "привет"';
    try {
      await navigator.clipboard.writeText(command);
      button.textContent = "Скопировано";
      window.setTimeout(() => {
        button.textContent = "Скопировать стартовую команду";
      }, 1800);
    } catch {
      button.textContent = "Не удалось скопировать";
      window.setTimeout(() => {
        button.textContent = "Скопировать стартовую команду";
      }, 1800);
    }
  });
}
