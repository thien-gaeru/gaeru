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
    const visible = filter === "all" || card.dataset.kind === filter;
    card.hidden = !visible;
    if (visible) visibleCount += 1;
  });
  const status = productSection.querySelector(".filter-status");
  if (status) status.textContent = filter === "all" ? "" : `${visibleCount} sản phẩm`;
});
