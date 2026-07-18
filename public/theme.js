/**
 * @file public/theme.js
 * @description Resolve, persist, and apply the dashboard color theme
 */

(function exposeDashboardTheme(globalScope) {
  "use strict";

  const STORAGE_KEY = "maze-bench-theme";
  const THEME_EVENT = "maze-bench:themechange";
  const mediaQuery = globalScope.matchMedia?.("(prefers-color-scheme: dark)");
  let savedTheme = _savedTheme();
  let currentTheme = savedTheme ?? (mediaQuery?.matches ? "dark" : "light");

  /** @description Normalize supported theme values */
  function _normalizeTheme(theme) {
    return theme === "dark" ? "dark" : "light";
  }

  /** @description Read a valid saved theme when browser storage is available */
  function _savedTheme() {
    try {
      const saved = globalScope.localStorage?.getItem(STORAGE_KEY);
      return saved === "light" || saved === "dark" ? saved : null;
    } catch {
      return null;
    }
  }

  /** @description Return the active dashboard theme */
  function getTheme() {
    return currentTheme;
  }

  /** @description Return the translated action for the current theme */
  function _toggleLabel() {
    const key = currentTheme === "dark"
      ? "common.switchLightTheme"
      : "common.switchDarkTheme";
    return globalScope.MazeBenchI18n?.t(key)
      ?? (currentTheme === "dark" ? "Switch to light mode" : "Switch to dark mode");
  }

  /** @description Apply the active theme and bind theme controls */
  function applyDocument(root = globalScope.document) {
    const documentElement = globalScope.document?.documentElement;
    if (!documentElement) {
      return;
    }
    documentElement.dataset.theme = currentTheme;
    documentElement.style.colorScheme = currentTheme;
    if (!root?.querySelectorAll) {
      return;
    }
    for (const button of root.querySelectorAll("[data-theme-toggle]")) {
      const label = _toggleLabel();
      button.setAttribute("aria-label", label);
      button.setAttribute("title", label);
      button.setAttribute("aria-pressed", String(currentTheme === "dark"));
      button.dataset.activeTheme = currentTheme;
      const icon = button.querySelector("[data-theme-icon]");
      if (icon) {
        icon.textContent = currentTheme === "dark" ? "☀" : "☾";
      }
      if (button.dataset.themeBound !== "true") {
        button.dataset.themeBound = "true";
        button.addEventListener("click", toggleTheme);
      }
    }
  }

  /** @description Persist and apply a supported dashboard theme */
  function setTheme(theme) {
    const nextTheme = _normalizeTheme(theme);
    const changed = nextTheme !== currentTheme;
    savedTheme = nextTheme;
    try {
      globalScope.localStorage?.setItem(STORAGE_KEY, nextTheme);
    } catch {
      // Theme persistence is optional when browser storage is unavailable.
    }
    if (!changed) {
      return currentTheme;
    }
    currentTheme = nextTheme;
    applyDocument();
    if (typeof globalScope.dispatchEvent === "function") {
      globalScope.dispatchEvent(new CustomEvent(THEME_EVENT, {
        detail: { theme: currentTheme },
      }));
    }
    return currentTheme;
  }

  /** @description Switch between light and dark themes */
  function toggleTheme() {
    return setTheme(currentTheme === "dark" ? "light" : "dark");
  }

  const api = {
    STORAGE_KEY,
    THEME_EVENT,
    applyDocument,
    getTheme,
    setTheme,
    toggleTheme,
  };

  globalScope.MazeBenchTheme = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }

  applyDocument();
  globalScope.addEventListener?.("DOMContentLoaded", () => applyDocument());
  globalScope.addEventListener?.("maze-bench:localechange", () => applyDocument());
  mediaQuery?.addEventListener?.("change", (event) => {
    if (savedTheme !== null) {
      return;
    }
    currentTheme = event.matches ? "dark" : "light";
    applyDocument();
    globalScope.dispatchEvent?.(new CustomEvent(THEME_EVENT, {
      detail: { theme: currentTheme },
    }));
  });
}(globalThis));
