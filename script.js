const filterButtons = [...document.querySelectorAll(".filter-chip")];
const productCards = [...document.querySelectorAll(".product-card")];
const filterStatus = document.querySelector(".filter-status");

filterButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const filter = button.dataset.filter;
    let visibleCount = 0;
    filterButtons.forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-active", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    productCards.forEach((card) => {
      const visible = filter === "all" || card.dataset.kind === filter;
      card.hidden = !visible;
      if (visible) visibleCount += 1;
    });
    filterStatus.textContent = filter === "all" ? "" : `${visibleCount} sản phẩm`;
  });
});
