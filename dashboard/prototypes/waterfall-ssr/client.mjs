import { serializeViewCookie, VIEW_MODES } from "/view-mode.mjs";

const root = document.documentElement;
const currentMode = root.dataset.viewMode;
const status = document.querySelector(".switch-status");
const params = new URLSearchParams(window.location.search);

if (params.get("from") === "switch") {
  window.history.replaceState({}, "", "/");
}

for (const button of document.querySelectorAll("[data-select-view]")) {
  button.addEventListener("click", () => {
    const nextMode = button.dataset.selectView;
    if (!VIEW_MODES.includes(nextMode) || nextMode === currentMode) return;

    document.cookie = serializeViewCookie(nextMode);
    try {
      localStorage.setItem("aifeeds_view", nextMode);
    } catch {
      // Cookie remains the SSR authority; storage can be unavailable in privacy modes.
    }

    for (const control of document.querySelectorAll("[data-select-view]")) {
      control.setAttribute("aria-busy", "true");
      control.disabled = true;
    }
    document.querySelector(".view-menu[open]")?.removeAttribute("open");
    if (status) status.textContent = `正在切换到${nextMode === "waterfall" ? "瀑布版" : "经典版"}…`;

    window.setTimeout(() => {
      window.location.assign(`/?view=${nextMode}&from=switch`);
    }, 80);
  });
}
