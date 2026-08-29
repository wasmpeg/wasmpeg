(() => {
  const root = document.documentElement;

  // 1. Theme Toggle & Persistence
  const updateTheme = (next) => {
    root.dataset.theme = next;
    try { localStorage.setItem('wasmpeg-theme', next); } catch (_) {}
  };

  document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
    const current = root.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    updateTheme(next);
  });

  // 2. Mobile Sidebar Drawer Toggle
  const navToggle = document.querySelector('[data-nav-toggle]');
  const sidebar = document.querySelector('[data-sidebar]');
  navToggle?.addEventListener('click', () => {
    sidebar?.classList.toggle('is-open');
  });

  // 3. Sidebar Scroll Position Preservation
  if (sidebar) {
    const scrollKey = 'wasmpeg-sidebar-scroll';
    try {
      const saved = sessionStorage.getItem(scrollKey);
      if (saved !== null) {
        sidebar.scrollTop = parseInt(saved, 10);
      }
    } catch (_) {}

    sidebar.addEventListener('scroll', () => {
      try { sessionStorage.setItem(scrollKey, sidebar.scrollTop.toString()); } catch (_) {}
    }, { passive: true });

    // Ensure active link is comfortably in view
    const active = sidebar.querySelector('.sidebar-nav .is-active');
    if (active) {
      const sRect = sidebar.getBoundingClientRect();
      const aRect = active.getBoundingClientRect();
      if (aRect.top < sRect.top + 20 || aRect.bottom > sRect.bottom - 20) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  // 4. Code Block Copy Buttons
  const copySvg = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
  const checkSvg = `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>`;

  for (const block of document.querySelectorAll('.highlight')) {
    if (block.closest('.hero-code')) continue;
    const btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.setAttribute('aria-label', 'Copy code snippet');
    btn.innerHTML = copySvg;
    btn.addEventListener('click', async () => {
      const code = block.querySelector('code')?.innerText ?? '';
      try {
        await navigator.clipboard.writeText(code);
        btn.classList.add('copied');
        btn.innerHTML = checkSvg;
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.innerHTML = copySvg;
        }, 1800);
      } catch (_) {}
    });
    block.appendChild(btn);
  }

  // 5. Install Snippet Copy (Hero / Quickstart)
  document.querySelectorAll('[data-copy-text]').forEach((el) => {
    el.addEventListener('click', async () => {
      const text = el.getAttribute('data-copy-text');
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        const origHtml = el.innerHTML;
        el.innerHTML = `<svg class="icon" style="color:var(--ok)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg> Copied!`;
        setTimeout(() => { el.innerHTML = origHtml; }, 1800);
      } catch (_) {}
    });
  });

  // 6. Table of Contents Scroll Spy
  const tocLinks = [...document.querySelectorAll('.toc a')];
  if (tocLinks.length) {
    const headings = tocLinks
      .map((a) => document.getElementById(decodeURIComponent(a.hash.slice(1))))
      .filter(Boolean);

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          tocLinks.forEach((a) => a.classList.remove('is-active'));
          const activeLink = tocLinks.find((a) => a.hash === `#${entry.target.id}`);
          if (activeLink) activeLink.classList.add('is-active');
        }
      }
    }, { rootMargin: '-80px 0px -70% 0px' });

    headings.forEach((h) => observer.observe(h));
  }

  // 7. Search Modal & Index
  const modal = document.querySelector('[data-search-modal]');
  const input = document.querySelector('[data-search-input]');
  const results = document.querySelector('[data-search-results]');
  let searchIndex = null;
  let selectedIdx = 0;

  const openSearch = async () => {
    if (!modal) return;
    modal.hidden = false;
    input?.focus();
    input?.select();
    if (!searchIndex) {
      try {
        searchIndex = await fetch('/index.json').then((r) => r.json());
      } catch (_) {
        searchIndex = [];
      }
    }
  };

  const closeSearch = () => {
    if (!modal) return;
    modal.hidden = true;
  };

  document.querySelector('[data-search-open]')?.addEventListener('click', openSearch);
  document.querySelector('[data-search-close]')?.addEventListener('click', closeSearch);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeSearch();
  });

  window.addEventListener('keydown', (e) => {
    if ((e.key === '/' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) ||
        (e.key === 'k' && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      openSearch();
    } else if (e.key === 'Escape' && modal && !modal.hidden) {
      closeSearch();
    }
  });

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const makeSnippet = (text, q) => {
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) return escapeHtml(text.slice(0, 100));
    const start = Math.max(0, idx - 30);
    const raw = text.slice(start, start + 110);
    const escaped = escapeHtml(raw);
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return (start > 0 ? '…' : '') + escaped.replace(regex, '<mark>$1</mark>');
  };

  const renderSearch = () => {
    if (!input || !results) return;
    const q = input.value.trim().toLowerCase();
    if (!q) {
      results.innerHTML = '';
      return;
    }
    const hits = (searchIndex ?? [])
      .map((item) => {
        const title = (item.t || '').toLowerCase();
        const desc = (item.d || '').toLowerCase();
        const content = (item.c || '').toLowerCase();
        let score = 0;
        if (title === q) score = 100;
        else if (title.startsWith(q)) score = 70;
        else if (title.includes(q)) score = 50;
        else if (desc.includes(q)) score = 25;
        else if (content.includes(q)) score = 10;
        return { item, score };
      })
      .filter((h) => h.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    selectedIdx = 0;
    if (!hits.length) {
      results.innerHTML = '<div class="sr-empty">No matching documents found</div>';
      return;
    }

    results.innerHTML = hits.map(({ item }, i) => `
      <a class="sr${i === 0 ? ' is-sel' : ''}" href="${item.u}">
        <div class="sr-sec">${escapeHtml(item.s || 'Docs')}</div>
        <div class="sr-title">${escapeHtml(item.t)}</div>
        <div class="sr-desc">${makeSnippet(item.d || item.c || '', q)}</div>
      </a>
    `).join('');
  };

  input?.addEventListener('input', renderSearch);
  input?.addEventListener('keydown', (e) => {
    const items = [...results.querySelectorAll('.sr')];
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[selectedIdx]?.classList.remove('is-sel');
      selectedIdx = (selectedIdx + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items[selectedIdx]?.classList.add('is-sel');
      items[selectedIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[selectedIdx]?.click();
    }
  });
})();
