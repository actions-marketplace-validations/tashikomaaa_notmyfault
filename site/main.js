// Copy buttons stay hidden without JavaScript or clipboard access.
for (const button of document.querySelectorAll("button[data-copy]")) {
  const source = document.getElementById(button.dataset.copy);
  if (!source || !navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(source.textContent);
      button.textContent = "Copied";
    } catch {
      button.textContent = "Copy failed";
    }
    setTimeout(() => (button.textContent = "Copy"), 2000);
  });
}
