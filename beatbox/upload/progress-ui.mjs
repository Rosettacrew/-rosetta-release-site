import { statusMessage } from "./status-copy.mjs";

export function applyProgress(els, state = {}) {
  if (!els?.status) return;
  const message = state.message || statusMessage(state);
  els.status.textContent = message;
  const ratio = Number(state.ratio);
  const percent = Number.isFinite(ratio) ? Math.max(0, Math.min(100, Math.round(ratio * 100))) : 0;
  if (els.bar) els.bar.style.width = `${percent}%`;
  if (els.progress) {
    els.progress.setAttribute("aria-valuenow", String(percent));
    els.progress.setAttribute("aria-valuemin", "0");
    els.progress.setAttribute("aria-valuemax", "100");
  }
}

export function mountProgress(root) {
  const els = {
    status: root.querySelector("[data-upload-status]"),
    bar: root.querySelector("[data-upload-bar]"),
    progress: root.querySelector("[data-upload-progress]"),
  };
  return {
    render(state) {
      applyProgress(els, state);
    },
  };
}
