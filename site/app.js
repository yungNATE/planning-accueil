// Amélioration progressive : ouverture des fenêtres de mois, abonnement, copie d'adresse.
// La page fonctionne sans ce script (tableau de liens dans <noscript>).

const STORAGE_KEY = 'planning-accueil:dernier-nom';

function readLastName() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function saveLastName(slug) {
  try { localStorage.setItem(STORAGE_KEY, slug); } catch { /* stockage indisponible : sans conséquence */ }
}

// Adresses d'abonnement calculées à partir de l'adresse réelle du site
for (const input of document.querySelectorAll('input[data-path]')) {
  input.value = new URL(input.dataset.path, document.baseURI).href;
}
for (const link of document.querySelectorAll('a.webcal[data-path]')) {
  link.href = new URL(link.dataset.path, document.baseURI).href.replace(/^https?:/, 'webcal:');
}

// Ouverture d'un mois
for (const opener of document.querySelectorAll('[data-open]')) {
  opener.addEventListener('click', () => {
    const dialog = document.getElementById(opener.dataset.open);
    if (!dialog) return;
    dialog.showModal();
    const last = readLastName();
    const target = (last && dialog.querySelector(`a[data-slug="${CSS.escape(last)}"]`))
      || dialog.querySelector('a[data-slug]')
      || dialog.querySelector('[data-close]');
    target?.focus();
    dialog.addEventListener('close', () => opener.focus(), { once: true });
  });
}

for (const dialog of document.querySelectorAll('dialog.sheet')) {
  const announce = (text) => {
    const region = dialog.querySelector('[data-announce]');
    if (!region) return;
    region.textContent = '';
    setTimeout(() => { region.textContent = text; }, 50);
  };

  // Clic en dehors de la fenêtre (sur le fond) : fermeture
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });

  dialog.querySelector('[data-close]')?.addEventListener('click', () => dialog.close());

  for (const link of dialog.querySelectorAll('a[data-slug]')) {
    link.addEventListener('click', () => saveLastName(link.dataset.slug));
  }

  for (const toggle of dialog.querySelectorAll('.person__subscribe')) {
    toggle.addEventListener('click', () => {
      const panel = document.getElementById(toggle.getAttribute('aria-controls'));
      const open = toggle.getAttribute('aria-expanded') !== 'true';
      toggle.setAttribute('aria-expanded', String(open));
      if (panel) panel.hidden = !open;
    });
  }

  for (const button of dialog.querySelectorAll('[data-copy]')) {
    button.addEventListener('click', async () => {
      const input = document.getElementById(button.dataset.copy);
      if (!input) return;
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        input.select();
        document.execCommand('copy');
      }
      button.textContent = 'Copiée';
      announce('Adresse copiée.');
      setTimeout(() => { button.textContent = 'Copier'; }, 2500);
    });
  }
}
