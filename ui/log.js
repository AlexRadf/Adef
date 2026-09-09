// Combat log: appends only what is new. It is the primary debugging tool
// and an authentic raid artifact at the same time.

const MAX_LINES = 220;

export function createLog(node) {
  let lastSeq = 0;
  return {
    reset() {
      lastSeq = 0;
      node.innerHTML = '';
    },
    push(entries) {
      const fresh = entries.filter((e) => e.seq > lastSeq);
      if (!fresh.length) return;
      lastSeq = fresh[fresh.length - 1].seq;
      const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 40;
      for (const e of fresh) {
        const line = document.createElement('div');
        line.className = e.kind;
        line.innerHTML = `<span class="t">${(e.tick / 10).toFixed(1)}</span> ${escapeHtml(e.text)}`;
        node.appendChild(line);
      }
      while (node.childElementCount > MAX_LINES) node.removeChild(node.firstChild);
      if (atBottom) node.scrollTop = node.scrollHeight;
    },
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}
