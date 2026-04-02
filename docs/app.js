const copyTargets = [
  { id: "copy-command", value: 'npm link && clama "hello"', label: "Copy quick-start command" },
  {
    id: "copy-ton-address",
    value: "UQAus-A84cilefwzo5zbpmTLOOCyzwL8kE9IMkHRqPM-N7nz",
    label: "Copy TON address",
  },
];

for (const target of copyTargets) {
  const button = document.getElementById(target.id);

  if (!button) {
    continue;
  }

  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(target.value);
      button.textContent = "Copied";
      window.setTimeout(() => {
        button.textContent = target.label;
      }, 1800);
    } catch {
      button.textContent = "Copy failed";
      window.setTimeout(() => {
        button.textContent = target.label;
      }, 1800);
    }
  });
}
