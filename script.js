const productSection = document.querySelector(".product-section");

productSection?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-filter]");
  if (!button) return;
  const filter = button.dataset.filter;
  const filterButtons = [...productSection.querySelectorAll("[data-filter]")];
  const cards = [...productSection.querySelectorAll(".product-card")];
  let visibleCount = 0;

  filterButtons.forEach((item) => {
    const selected = item === button;
    item.classList.toggle("is-active", selected);
    item.setAttribute("aria-pressed", String(selected));
  });
  cards.forEach((card) => {
    const kind = card.dataset.kind || card.dataset.category;
    const visible = filter === "all" || kind === filter || (filter === "video" && kind === "accessory");
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  const status = productSection.querySelector(".filter-status");
  if (status) status.textContent = filter === "all" ? "" : `${visibleCount} sản phẩm`;
  const gridEl = productSection.querySelector('.product-grid');
  if (gridEl) gridEl.scrollLeft = 0;
});

// Move a whole two-row column while keeping native touch/trackpad scrolling.
// Child links and buttons retain their ordinary keyboard behavior.
productSection?.querySelector('.product-grid')?.addEventListener('keydown', event => {
  const rail = event.currentTarget;
  if (event.target !== rail || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const cards = [...rail.querySelectorAll('.product-card')].filter(card => !card.hidden);
  if (!cards.length || rail.scrollWidth <= rail.clientWidth) return;
  event.preventDefault();
  const gap = Number.parseFloat(getComputedStyle(rail).columnGap) || 0;
  const step = cards[0].getBoundingClientRect().width + gap;
  const left = event.key === 'Home' ? 0 : event.key === 'End' ? rail.scrollWidth - rail.clientWidth : rail.scrollLeft + (event.key === 'ArrowRight' ? step : -step);
  rail.scrollTo({ left, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
});
