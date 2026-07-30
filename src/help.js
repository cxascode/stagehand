async function renderHelp() {
  const manifest = chrome.runtime.getManifest();
  document.getElementById("version").textContent = manifest.version;
  document.getElementById("tagline").textContent = manifest.description;
  document.getElementById("toolNote").textContent = HELP_NOTE;

  const { genesysAppsOrigin } = await chrome.storage.local.get("genesysAppsOrigin");

  const list = document.getElementById("toolList");
  const empty = document.getElementById("emptyState");
  list.replaceChildren();

  if (!PAGE_ROUTES.length) {
    empty.hidden = false;
    return;
  }

  empty.hidden = true;

  for (const route of PAGE_ROUTES) {
    const entry = document.createElement("article");
    entry.className = "toolEntry";

    const heading = document.createElement("h3");
    const link = document.createElement("a");
    link.textContent = route.title;
    link.href = "#";
    link.addEventListener("click", (e) => {
      e.preventDefault();
      if (!genesysAppsOrigin) {
        window.alert("Open Genesys Cloud in this browser first so stagehand knows your region.");
        return;
      }
      chrome.tabs.create({ url: buildRouteUrl(genesysAppsOrigin, route) });
    });
    if (!genesysAppsOrigin) {
      link.title = "Open Genesys Cloud once so stagehand knows your region";
    }
    heading.appendChild(link);

    const desc = document.createElement("p");
    desc.textContent = route.description;

    entry.append(heading, desc);
    list.appendChild(entry);
  }
}

renderHelp();
